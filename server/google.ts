import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { GOOGLE_VOICE_NAME } from "../shared/google";
import { clearKey, readKey, saveKey } from "./google-key";

export const GOOGLE_API = "https://texttospeech.googleapis.com/v1";
export const GOOGLE_SETTINGS = "Open Paseo Settings > Plugins and select the cog next to Read Aloud.";

const errorResponse = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

export class GoogleSpeechError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function googleError(response: Response, operation: "speech" | "voices"): Promise<GoogleSpeechError> {
  const { data } = errorResponse.safeParse(await response.json().catch(() => null));
  const error = data?.error;
  const reasons = error?.details?.map(({ reason }) => reason) ?? [];
  if (response.status === 429 || error?.status === "RESOURCE_EXHAUSTED") {
    return new GoogleSpeechError(429, "Google's text-to-speech quota is reached. Try again in a moment.");
  }
  if (response.status === 401 || reasons.includes("API_KEY_INVALID")) {
    return new GoogleSpeechError(401, "Google rejected the API key.");
  }
  if (reasons.includes("SERVICE_DISABLED")) {
    return new GoogleSpeechError(502, "Turn on the Cloud Text-to-Speech API for this key's Google Cloud project.");
  }
  if (reasons.some((reason) => reason?.startsWith("BILLING_")) || /billing.*(?:disabled|not enabled|required)/i.test(error?.message ?? "")) {
    return new GoogleSpeechError(502, "Turn on billing for this key's Google Cloud project.");
  }
  if (operation === "speech" && [400, 404].includes(response.status)) {
    return new GoogleSpeechError(400, "Google rejected the speech request. Check that the selected Chirp 3 HD voice is available.");
  }
  // Upstream error text can echo credentials or the text being spoken.
  return new GoogleSpeechError(502, `Google text-to-speech ${operation === "speech" ? "synthesis" : "voice lookup"} failed (${response.status}).`);
}

const RETRY_DELAYS_MS = [300, 600, 1200];

export async function fetchGoogle(
  request: () => Promise<Response>, operation: "speech" | "voices", signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await request();
    } catch {
      signal.throwIfAborted();
      throw new GoogleSpeechError(502, `Could not reach Google for ${operation}.`);
    }
    if (response.ok) return response;
    const delay = RETRY_DELAYS_MS[attempt];
    if ((response.status === 429 || response.status === 503) && delay !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      await setTimeout(delay, undefined, { signal });
      continue;
    }
    const error = await googleError(response, operation);
    signal.throwIfAborted();
    throw error;
  }
}

const voiceList = z.object({
  voices: z.array(z.object({ name: z.string(), ssmlGender: z.string().optional() })).default([]),
});

async function fetchVoiceList(apiKey: string) {
  const locale = "en-US";
  const signal = AbortSignal.timeout(60_000);
  const response = await fetchGoogle(() => fetch(`${GOOGLE_API}/voices?languageCode=${locale}`, {
    headers: { "X-Goog-Api-Key": apiKey },
    // This is Node's fetch, despite React Native's global declarations.
    signal: signal as RequestInit["signal"],
  }), "voices", signal);
  const result = voiceList.safeParse(await response.json().catch(() => null));
  if (!result.success) throw new Error("Google returned an invalid voice list.");
  return result.data.voices.flatMap(({ name: id, ssmlGender }) => {
    const match = GOOGLE_VOICE_NAME.exec(id);
    if (!match || match[1] !== locale) return [];
    const [, , name] = match;
    const gender = ssmlGender && ssmlGender !== "SSML_VOICE_GENDER_UNSPECIFIED" ? `, ${ssmlGender.toLowerCase()}` : "";
    return [{ id, name: `${name} (US English${gender})` }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function keyStatus() {
  const { source } = readKey();
  return { saved: source !== "none", source };
}

export async function validateAndSaveKey({ apiKey }: { apiKey: string }) {
  try {
    await fetchVoiceList(apiKey);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Google key validation failed." };
  }
  try {
    saveKey(apiKey);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the Google API key on this host." };
  }
}

export function removeKey() {
  try {
    clearKey();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function listVoices() {
  const { apiKey } = readKey();
  if (!apiKey) throw new Error("No Google API key is configured. " + GOOGLE_SETTINGS);
  return { voices: await fetchVoiceList(apiKey) };
}
