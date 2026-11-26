/// <reference types="node" />
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";
import { GOOGLE_VOICE_NAME } from "../shared/google";
import type { VoiceSettings } from "../shared/settings";
import type { SpeechFile, SpeechRequest, VoiceStatus } from "../shared/speech";
import { GOOGLE_API, GOOGLE_SETTINGS, GoogleSpeechError, fetchGoogle } from "./google";
import type { HubClient } from "./managed";
import { adjustManagedSpeed, isManagedSpeedAvailable, SPEED_UNAVAILABLE } from "./managed-speed";
import { readDaemonConfig, requiredFiles, resolveVoice, type ResolvedVoice, type TtsEngine } from "./voices";

type LocalVoice = Extract<ResolvedVoice, { provider: "local" }>;
type OpenAiVoice = Extract<ResolvedVoice, { provider: "openai" }>;
type GoogleVoice = Extract<ResolvedVoice, { provider: "google" }>;

const PLUGIN_ID = "read-aloud";

// ---------- Sessions ----------

/** Sessions the client has stopped. Their queued chunks are skipped instead of generated. */
const cancelled = new Set<string>();
const inFlight = new Map<string, Set<AbortController>>();

class Cancelled extends Error {
  constructor() {
    super("Read aloud was stopped");
  }
}

function isCancelled(session: string | undefined): boolean {
  return session !== undefined && cancelled.has(session);
}

/** Marks a session stopped and aborts its network requests. Keeps the set small. */
export async function cancel({ session }: { session: string }): Promise<{ ok: boolean }> {
  cancelled.add(session);
  if (cancelled.size > 200) cancelled.delete(cancelled.values().next().value as string);
  for (const controller of inFlight.get(session) ?? []) controller.abort();
  inFlight.delete(session);
  return { ok: true };
}

// ---------- Cloud voices ----------

const REQUEST_TIMEOUT_MS = 60_000;
const CLOUD_SAMPLE_RATE = 24_000;
const mp3Endpoints = new Set<string>();

async function withSpeechRequest<T>(
  provider: string, session: string | undefined, request: (signal: AbortSignal) => Promise<T>,
  consumerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  if (session) {
    const set = inFlight.get(session) ?? new Set();
    set.add(controller);
    inFlight.set(session, set);
  }
  // The timeout aborts the request itself (and reading its body), rather than abandoning it.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, timeout, ...(consumerSignal ? [consumerSignal] : [])]);
  try {
    return await request(signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Cancelled();
    if (timeout.aborted) throw new Error(`${provider} TTS request timed out`);
    throw error;
  } finally {
    const set = session ? inFlight.get(session) : undefined;
    set?.delete(controller);
    if (session && set?.size === 0) inFlight.delete(session);
  }
}

async function synthesizeOpenAi(voice: OpenAiVoice, text: string, session?: string): Promise<SpeechFile> {
  if (!voice.apiKey) {
    throw new Error("OpenAI TTS is selected in Paseo's voice settings but no API key is configured");
  }
  return withSpeechRequest("OpenAI", session, async (signal) => {
    const request = (format: "pcm" | "mp3") => fetch(voice.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${voice.apiKey}` },
      body: JSON.stringify({ model: voice.model, voice: voice.voice, input: text, response_format: format }),
      signal: signal as RequestInit["signal"],
    });
    let format: "mp3" | "pcm" = mp3Endpoints.has(voice.endpoint) ? "mp3" : "pcm";
    let response = await request(format);
    if (!response.ok) {
      const detail = await response.text();
      if (format === "pcm" && response.status === 400 && /\b(?:\w*format|pcm)\b/i.test(detail)) {
        mp3Endpoints.add(voice.endpoint);
        format = "mp3";
        response = await request(format);
      } else {
        throw openAiError(response.status, detail);
      }
    }
    if (!response.ok) throw openAiError(response.status, await response.text());
    const body = await response.arrayBuffer();
    return format === "pcm"
      ? pcm16Clip(body)
      : { base64: Buffer.from(body).toString("base64"), mimeType: "audio/mpeg" };
  });
}

function openAiError(status: number, body: string): Error {
  const detail = body.slice(0, 200).trim();
  return new Error(`OpenAI TTS request failed (${status})${detail ? ": " + detail : ""}`);
}

export type GoogleAudioFormat = "MP3" | "LINEAR16";
const googleAudio = z.object({ audioContent: z.base64().min(1) });
const GOOGLE_CHUNK_BYTES = 4_500;

function* googleChunks(text: string, languageCode: string): Iterable<string> {
  if (Buffer.byteLength(text) <= GOOGLE_CHUNK_BYTES) {
    yield text;
    return;
  }
  const segmenter = new Intl.Segmenter(languageCode, { granularity: "sentence" });
  const sentences = new Set(Array.from(segmenter.segment(text), ({ index, segment }) => index + segment.length));
  for (let start = 0; start < text.length;) {
    let end = start;
    let sentenceEnd = start;
    let wordEnd = start;
    let bytes = 0;
    // String iteration advances by code point, so even a hard split preserves UTF-8 characters.
    for (const char of text.slice(start)) {
      bytes += Buffer.byteLength(char);
      if (bytes > GOOGLE_CHUNK_BYTES) break;
      end += char.length;
      if (sentences.has(end)) sentenceEnd = end;
      if (/\s/.test(char)) wordEnd = end;
    }
    if (end < text.length) {
      if (sentenceEnd > start) end = sentenceEnd;
      else if (wordEnd > start) end = wordEnd;
    }
    const chunk = text.slice(start, end);
    if (chunk.trim()) yield chunk;
    start = end;
  }
}

export async function requestGoogle(
  voice: Pick<GoogleVoice, "apiKey" | "voiceName" | "speed">,
  { text, session, format, fetchSpeech = fetch, signal: consumerSignal }:
    Pick<SpeechRequest, "text" | "session"> & {
      format: GoogleAudioFormat; fetchSpeech?: typeof fetch; signal?: AbortSignal;
    },
): Promise<Buffer> {
  const { apiKey, voiceName, speed } = voice;
  if (!apiKey) throw new GoogleSpeechError(400, "No Google API key is configured. " + GOOGLE_SETTINGS);
  const languageCode = GOOGLE_VOICE_NAME.exec(voiceName)?.[1];
  if (!languageCode) throw new GoogleSpeechError(400, "Choose a Google Chirp 3 HD voice. " + GOOGLE_SETTINGS);
  const audioConfig = {
    audioEncoding: format,
    ...(format === "LINEAR16" ? { sampleRateHertz: CLOUD_SAMPLE_RATE } : {}),
    speakingRate: speed,
  };
  return withSpeechRequest("Google", session, async (signal) => {
    const clips: Buffer[] = [];
    for (const chunk of googleChunks(text, languageCode)) {
      if (!chunk.trim()) continue;
      const body = JSON.stringify({ input: { text: chunk }, voice: { languageCode, name: voiceName }, audioConfig });
      const response = await fetchGoogle(() => fetchSpeech(`${GOOGLE_API}/text:synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
        body,
        signal: signal as RequestInit["signal"],
      }), "speech", signal);
      const result = googleAudio.safeParse(await response.json().catch(() => null));
      signal.throwIfAborted();
      if (!result.success) throw new GoogleSpeechError(502, "Google returned invalid speech audio.");
      clips.push(Buffer.from(result.data.audioContent, "base64"));
    }
    const [first, ...rest] = clips;
    if (!first) throw new GoogleSpeechError(400, "Nothing to read aloud");
    if (!rest.length) return first;
    return format === "LINEAR16" ? joinWav(first, rest) : Buffer.concat(clips);
  }, consumerSignal);
}

// ---------- Local voices ----------

type Audio = { samples: Float32Array | number[]; sampleRate: number };
interface LocalEngine {
  generate(text: string, sid: number, speed: number): Promise<Audio>;
  /** Releases the model's memory, when the runtime offers a way to. */
  dispose(): void;
}

/** More threads make each chunk faster; leave headroom for the agents themselves. */
const NATIVE_THREADS = Math.max(2, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));

/** The engine block of sherpa's TTS config, built the way Paseo's voice mode builds it. */
function modelBlock(dir: string, engine: TtsEngine) {
  const file = (name: string) => path.join(dir, name);
  const shared = { model: file(engine.model), tokens: file(engine.tokens), lengthScale: 1.0 };
  switch (engine.family) {
    case "kokoro":
      return {
        kokoro: {
          ...shared,
          voices: file(engine.voices ?? "voices.bin"),
          dataDir: engine.dataDir ? file(engine.dataDir) : "",
          lexicon: (engine.lexicons ?? []).map(file).join(","),
          dictDir: engine.dictDir ? file(engine.dictDir) : "",
        },
      };
    case "kitten":
      return { kitten: { ...shared, voices: file(engine.voices ?? "voices.bin"), dataDir: engine.dataDir ? file(engine.dataDir) : "" } };
    case "vits":
      return { vits: { ...shared, dataDir: engine.dataDir ? file(engine.dataDir) : "" } };
  }
}

/**
 * Paseo's own native sherpa-onnx runtime, the one its voice mode uses. Plugin server bundles run
 * with Paseo's module resolver, so a non-literal require reaches it. It is fast and asynchronous.
 */
function nativeEngine(voice: LocalVoice): LocalEngine | null {
  const specifier = ["sherpa-onnx", "node"].join("-");
  let sherpa: {
    OfflineTts?: new (config: unknown) => { generateAsync(input: object): Promise<Audio>; free?: () => void };
  };
  try {
    sherpa = require(specifier);
  } catch {
    return null;
  }
  if (typeof sherpa.OfflineTts !== "function") return null;
  const tts = new sherpa.OfflineTts({
    model: { numThreads: NATIVE_THREADS, debug: false, provider: "cpu", ...modelBlock(voice.dir, voice.engine) },
    maxNumSentences: 1,
    ruleFsts: voice.engine.family === "kokoro" ? (voice.engine.ruleFsts ?? []).map((name) => path.join(voice.dir, name)).join(",") : "",
  });
  return {
    // Electron rejects native external buffers, so ask sherpa for a copied array.
    generate: (text, sid, speed) => tts.generateAsync({ text, sid, speed, enableExternalBuffer: false }),
    // Without free(), dropping the last reference lets the addon's finalizer release it.
    dispose: () => tts.free?.(),
  };
}

/** Where Paseo installed this plugin: config.json records the directory for every source kind. */
function pluginDirectory(): string | null {
  const plugins = readDaemonConfig().plugins ?? {};
  for (const entry of [plugins[PLUGIN_ID], ...Object.values(plugins)]) {
    if (entry?.enabled === false) continue;
    const dir = typeof entry?.path === "string" ? entry.path : null;
    if (!dir) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "paseo-plugin.json"), "utf8")) as { id?: string };
      if (manifest.id === PLUGIN_ID && fs.existsSync(path.join(dir, "node_modules", "sherpa-onnx"))) return dir;
    } catch {
      // Not this plugin.
    }
  }
  return null;
}

/** Fallback: the plugin's own WebAssembly build of sherpa-onnx (slower, blocks while generating). */
function wasmEngine(voice: LocalVoice): LocalEngine {
  const home = pluginDirectory();
  if (!home) throw new Error("Read Aloud could not find its installed files to load the speech engine.");
  // The bundle has no import.meta or __dirname, so resolve from the installed plugin directory.
  const sherpa = createRequire(path.join(home, "package.json"))("sherpa-onnx") as {
    createOfflineTts(config: unknown): { generate(input: object): Audio; free?: () => void };
  };
  const block = modelBlock(voice.dir, voice.engine);
  const wasmBlock =
    "kokoro" in block ? { offlineTtsKokoroModelConfig: { ...block.kokoro, lang: "" } }
    : "kitten" in block ? { offlineTtsKittenModelConfig: block.kitten }
    : { offlineTtsVitsModelConfig: { ...block.vits, lexicon: "", noiseScale: 0.667, noiseScaleW: 0.8 } };
  const tts = sherpa.createOfflineTts({ offlineTtsModelConfig: { numThreads: 1, debug: false, ...wasmBlock } });
  return { generate: async (text, sid, speed) => tts.generate({ text, sid, speed }), dispose: () => tts.free?.() };
}

let engine: { key: string; ready: Promise<LocalEngine> } | null = null;
/** The last voice that failed to load, so the status check can report it. */
let engineError: { key: string; message: string } | null = null;
/** The native handle is not reentrant: run one generation at a time. */
let queue: Promise<unknown> = Promise.resolve();

/** Frees an engine once every generation already queued on it has finished. */
function retire(old: { ready: Promise<LocalEngine> }) {
  const drained = queue;
  void Promise.all([old.ready, drained])
    .then(([local]) => local.dispose())
    .catch(() => undefined);
}

/** Frees the loaded voice (plugin stop). */
export function disposeEngine() {
  if (engine) retire(engine);
  engine = null;
}

function localEngine(voice: LocalVoice): Promise<LocalEngine> {
  const key = voice.dir + "|" + voice.modelId;
  if (engine?.key === key) return engine.ready;
  // Switching voices: let the old model go instead of keeping both in memory.
  if (engine) retire(engine);
  const ready = (async () => {
    const missing = requiredFiles(voice.engine).filter((name) => !fs.existsSync(path.join(voice.dir, name)));
    if (missing.length) {
      throw new Error(`Paseo's voice '${voice.label}' is not downloaded. Download it in Paseo Settings > Voice.`);
    }
    return nativeEngine(voice) ?? wasmEngine(voice);
  })();
  engine = { key, ready };
  // A failure is not cached: the next press tries again (for example after downloading the voice).
  ready.then(
    () => {
      if (engineError?.key === key) engineError = null;
    },
    (error: unknown) => {
      if (engine?.ready === ready) engine = null;
      const missing = requiredFiles(voice.engine).some((name) => !fs.existsSync(path.join(voice.dir, name)));
      if (!missing) engineError = { key, message: error instanceof Error ? error.message : String(error) };
    },
  );
  return ready;
}

/**
 * Cuts the near-silence models pad each clip with, keeping a short natural lead-in and pause.
 * Back-to-back clips then sound like continuous speech, and the first word arrives sooner.
 */
function trimSilence(samples: ArrayLike<number>, sampleRate: number): { start: number; end: number } {
  const threshold = 0.01;
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  if (start >= end) return { start: 0, end: 0 };
  return {
    start: Math.max(0, start - Math.round(sampleRate * 0.03)),
    end: Math.min(samples.length, end + Math.round(sampleRate * 0.12)),
  };
}

function allocatePcmWav(dataSize: number, sampleRate: number, channels = 1): Buffer {
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/** Float32 samples in -1..1 (a slice of them) to a 16-bit PCM mono WAV file. */
function encodeWav(samples: ArrayLike<number>, sampleRate: number, start = 0, end = samples.length): Buffer {
  const count = Math.max(0, end - start);
  const buffer = allocatePcmWav(count * 2, sampleRate);
  for (let i = 0; i < count; i++) {
    const value = Math.max(-1, Math.min(1, samples[start + i]));
    buffer.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

export function pcmClip(samples: ArrayLike<number>, sampleRate: number): SpeechFile {
  const { start, end } = trimSilence(samples, sampleRate);
  return {
    base64: encodeWav(samples, sampleRate, start, end).toString("base64"),
    mimeType: "audio/wav",
    durationMs: ((end - start) / sampleRate) * 1000,
  };
}

function pcm16Clip(body: ArrayBuffer | Uint8Array): SpeechFile {
  if (body.byteLength % 2 !== 0) throw new Error("Speech response contained incomplete PCM audio");
  const pcm = ArrayBuffer.isView(body)
    ? new DataView(body.buffer, body.byteOffset, body.byteLength)
    : new DataView(body);
  const samples = new Float32Array(body.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = pcm.getInt16(i * 2, true);
    samples[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
  }
  return pcmClip(samples, CLOUD_SAMPLE_RATE);
}

export function readPcmWav(audio: Buffer) {
  const invalid = () => new GoogleSpeechError(502, "Google returned an invalid PCM WAV file.");
  if (audio.length < 12 || audio.toString("latin1", 0, 4) !== "RIFF" || audio.toString("latin1", 8, 12) !== "WAVE") {
    throw invalid();
  }
  const end = audio.readUInt32LE(4) + 8;
  if (end > audio.length) throw invalid();

  let format: { channels: number; sampleRate: number } | undefined;
  let samples: Buffer | undefined;
  // RIFF allows metadata between these chunks and pads odd sizes to an even offset.
  for (let offset = 12; offset + 8 <= end;) {
    const chunk = audio.toString("latin1", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    offset = start + size + (size % 2);
    if (offset > end) throw invalid();
    if (chunk === "fmt ") {
      if (size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 14) !== 16) throw invalid();
      const channels = audio.readUInt16LE(start + 2);
      const sampleRate = audio.readUInt32LE(start + 4);
      if (!channels || !sampleRate || audio.readUInt16LE(start + 12) !== channels * 2 ||
          audio.readUInt32LE(start + 8) !== sampleRate * channels * 2) throw invalid();
      format = { channels, sampleRate };
    }
    if (chunk === "data") samples = audio.subarray(start, start + size);
    if (format && samples) {
      if (samples.length % (format.channels * 2) !== 0) throw invalid();
      return { ...format, samples };
    }
  }
  throw invalid();
}

function joinWav(first: Buffer, rest: Buffer[]): Buffer {
  const { channels, sampleRate, samples } = readPcmWav(first);
  const parts = [samples];
  let dataSize = samples.length;
  for (const wav of rest) {
    const part = readPcmWav(wav);
    if (part.channels !== channels || part.sampleRate !== sampleRate) {
      throw new GoogleSpeechError(502, "Google returned WAV clips with different audio formats.");
    }
    parts.push(part.samples);
    dataSize += part.samples.length;
  }
  const joined = allocatePcmWav(dataSize, sampleRate, channels);
  let offset = 44;
  for (const part of parts) offset += part.copy(joined, offset);
  return joined;
}

function wavClip(audio: Buffer): SpeechFile {
  const { channels, sampleRate, samples } = readPcmWav(audio);
  return { base64: audio.toString("base64"), mimeType: "audio/wav", durationMs: samples.length * 1000 / (sampleRate * channels * 2) };
}

export async function synthesizeManaged(
  hub: HubClient, { voiceId, speed }: VoiceSettings["managed"], { text, session }: SpeechRequest,
): Promise<SpeechFile> {
  if (isCancelled(session)) throw new Cancelled();
  return withSpeechRequest("Central voice", session, async (signal) => {
    if (speed !== 1 && !(await isManagedSpeedAvailable(signal))) throw new Error(SPEED_UNAVAILABLE);
    const pcm = await hub.synthesize(voiceId, text, signal);
    return pcm16Clip(await adjustManagedSpeed(pcm, speed, signal));
  });
}

async function synthesizeLocal(voice: LocalVoice, text: string, session?: string): Promise<SpeechFile> {
  const local = await localEngine(voice);
  // Chunks from a stopped press are skipped when their turn comes, so a new press isn't stuck
  // behind them.
  const run = queue.then(() => {
    if (isCancelled(session)) throw new Cancelled();
    return local.generate(text, voice.speakerId, voice.speed);
  });
  queue = run.catch(() => undefined);
  const audio = await run;
  return pcmClip(audio.samples, audio.sampleRate);
}

/** Speaks one chunk with the configured voice. */
export async function synthesize(input: SpeechRequest, settings?: VoiceSettings): Promise<SpeechFile> {
  const { text, session, localOnly, agentId } = input;
  if (!text.trim()) throw new Error("Nothing to read aloud");
  if (isCancelled(session)) throw new Cancelled();
  const voice = resolveVoice({ settings, agentId, localOnly });
  switch (voice.provider) {
    case "openai": return synthesizeOpenAi(voice, text, session);
    case "google": return wavClip(await requestGoogle(voice, { text, session, format: "LINEAR16" }));
    case "local": return synthesizeLocal(voice, text, session);
  }
}

const SPEAKING_SETTINGS = "Open Paseo Settings, choose Voice, and find Voice mode > Speaking.";

/** Checks the configured voice and says how to fix any problem; warms a working local voice. */
export async function checkVoice(settings?: VoiceSettings, { localOnly = false } = {}): Promise<VoiceStatus> {
  let voice: ResolvedVoice;
  try {
    voice = resolveVoice({ settings, localOnly });
  } catch (error) {
    return {
      ok: false,
      voice: "Unknown voice",
      provider: "unknown",
      problem: error instanceof Error ? error.message : "Paseo's voice settings couldn't be read.",
      steps: [SPEAKING_SETTINGS,
        localOnly ? "Choose a downloaded Local voice." : "Set Provider to Local or OpenAI and pick a voice from the Model list.",
        "Tap this warning again to re-check."],
    };
  }
  if (voice.provider === "google") {
    const label = voice.voiceLabel || voice.voiceName || "Google";
    const problem = !voice.apiKey ? "No Google API key is configured."
      : !GOOGLE_VOICE_NAME.test(voice.voiceName) ? "No Google Chirp 3 HD voice is selected." : undefined;
    return problem
      ? { ok: false, voice: label, provider: "google", problem, steps: [GOOGLE_SETTINGS] }
      : { ok: true, voice: label, provider: "google" };
  }
  if (voice.provider === "openai") {
    if (voice.apiKey) return { ok: true, voice: `OpenAI ${voice.voice}`, provider: "openai" };
    return {
      ok: false,
      voice: `OpenAI ${voice.voice}`,
      provider: "openai",
      problem: "OpenAI is selected for speaking, but no API key is saved.",
      steps: [SPEAKING_SETTINGS, "Enter your OpenAI API key and press Save, or switch Provider to Local.", "Tap this warning again to re-check."],
    };
  }
  const missing = requiredFiles(voice.engine).filter((name) => !fs.existsSync(path.join(voice.dir, name)));
  if (missing.length) {
    return {
      ok: false,
      voice: voice.label,
      provider: "local",
      problem: `The selected voice, ${voice.label}, isn't downloaded.`,
      steps: [
        SPEAKING_SETTINGS,
        `Next to ${voice.label}, press Download and wait until it shows Downloaded.`,
        "Or pick another voice that's already downloaded from the Model list.",
        "Tap this warning again to re-check.",
      ],
    };
  }
  if (engineError?.key === voice.dir + "|" + voice.modelId) {
    return {
      ok: false,
      voice: voice.label,
      provider: "local",
      problem: `${voice.label} is downloaded but couldn't be loaded: ${engineError.message}`,
      steps: [
        SPEAKING_SETTINGS,
        `Delete ${voice.label}, download it again, then tap this warning to re-check.`,
        "If it still fails, pick a different voice from the Model list.",
      ],
    };
  }
  // A chat with replies is open: load the voice now so the first press only has to generate.
  // Failures surface on the next status check, like any other load error.
  setTimeout(() => void localEngine(voice).catch(() => undefined), 0);
  return { ok: true, voice: voice.label, provider: "local" };
}
