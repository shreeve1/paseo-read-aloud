import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { VoiceSettings } from "../shared/settings";
import { readKey } from "./elevenlabs-key";
import { paseoHome } from "./paths";
import { ElevenLabsSpeechError, requestElevenLabs, type ElevenLabsAudioFormat } from "./tts";
import { readDaemonConfig, resolveOpenAiTtsKey } from "./voices";

const HOST = "127.0.0.1";
export const LEGACY_BRIDGE_KEY = "read-aloud-bridge";
const MAX_BODY_BYTES = 64 * 1024;
const CONTEXT_MS = 20_000;

export function bridgePort(env = process.env, uid = process.getuid?.() ?? 0) {
  const override = env.READ_ALOUD_BRIDGE_PORT?.trim();
  if (override && /^\d+$/.test(override)) {
    const port = Number(override);
    if (port >= 1024 && port <= 65535) return port;
  }
  return 20000 + (uid % 10000);
}

const speechInput = z.object({
  input: z.string().refine((text) => Boolean(text.trim())),
  response_format: z.enum(["pcm", "mp3", "wav"]).default("mp3"),
});

const formats = {
  pcm: { format: "pcm_24000", contentType: "audio/pcm" },
  mp3: { format: "mp3_44100_128", contentType: "audio/mpeg" },
  wav: { format: "wav_24000", contentType: "audio/wav" },
} satisfies Record<z.output<typeof speechInput>["response_format"], { format: ElevenLabsAudioFormat; contentType: string }>;

function sendError(res: ServerResponse, status: number, message: string) {
  if (res.destroyed) return;
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error"
    : status === 502 ? "server_error" : "invalid_request_error";
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type } }));
}

function matchesBearer(authorization: string | undefined, key: string) {
  const token = /^Bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      res.setHeader("Connection", "close");
      throw new Error("Speech request exceeds 64 KiB.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export function speechBridgeUrl(port = bridgePort()) {
  return `http://${HOST}:${port}/v1`;
}

export function startSpeechBridge({
  getSettings, env = process.env, port = bridgePort(env), fetchSpeech, now = Date.now,
}: {
  getSettings: () => Promise<VoiceSettings["elevenlabs"] | undefined>;
  port?: number;
  fetchSpeech?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  let last: { input: string; time: number } | undefined;
  let error: string | undefined;
  const lifetime = new AbortController();
  const home = paseoHome(env);

  async function speak(req: IncomingMessage, res: ServerResponse) {
    if (req.url?.split("?")[0] !== "/v1/audio/speech") return sendError(res, 404, "Speech endpoint not found.");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendError(res, 405, "Use POST to request speech.");
    }
    // A website must not be able to spend the local account's speech quota.
    if (req.headers.origin !== undefined) return sendError(res, 403, "Browser requests are not allowed.");

    const key = resolveOpenAiTtsKey(readDaemonConfig(home), env);
    if (!key || key === LEGACY_BRIDGE_KEY) {
      return sendError(res, 401, "No private speech bridge key is configured. Turn the Voice mode switch off and on again.");
    }
    if (!matchesBearer(req.headers.authorization, key)) return sendError(res, 401, "Invalid speech bridge bearer token.");

    let body: string;
    try {
      body = await readBody(req, res);
    } catch {
      return sendError(res, 400, "Could not read the speech request (limit: 64 KiB).");
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return sendError(res, 400, "Expected a JSON speech request.");
    }
    const parsed = speechInput.safeParse(json);
    if (!parsed.success) return sendError(res, 400, "Provide non-empty input and use pcm, mp3, or wav as response_format.");

    const { input, response_format } = parsed.data;
    const { format, contentType } = formats[response_format];
    const settings = await getSettings();
    const { apiKey } = readKey(env);
    const time = now();
    const previous = last && time - last.time < CONTEXT_MS ? last.input : undefined;
    last = { input, time };
    const consumer = new AbortController();
    res.once("close", () => consumer.abort());
    if (res.destroyed) return;
    const audio = await requestElevenLabs({
      apiKey, voiceId: settings?.voiceId ?? "", model: settings?.model ?? "", speed: settings?.speed ?? 1,
    }, { text: input, previous, format, fetchSpeech, signal: consumer.signal });
    res.writeHead(200, { "Content-Type": contentType });
    res.end(Buffer.from(audio));
  }

  const server = createServer((req, res) => {
    void speak(req, res).catch((cause: unknown) => {
      if (cause instanceof ElevenLabsSpeechError && cause.status !== 502) {
        return sendError(res, cause.status, cause.message);
      }
      sendError(res, 502, "Could not generate speech with ElevenLabs.");
    });
  });
  server.on("error", (cause: NodeJS.ErrnoException) => {
    if (error) return;
    error = `Read Aloud could not listen on ${HOST}:${port} (${cause.code ?? "unknown error"}).`;
    console.warn(error);
  });
  server.listen({ port, host: HOST, signal: lifetime.signal });

  return {
    status: () => ({ listening: server.listening, error }),
    url: () => {
      const address = server.address();
      const boundPort = address && typeof address === "object" ? address.port : port;
      return speechBridgeUrl(boundPort);
    },
    close: () => new Promise<void>((resolve) => {
      lifetime.abort();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
