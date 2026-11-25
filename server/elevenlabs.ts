import { z } from "zod";
import type { AccountVoice } from "../shared/elevenlabs";
import { clearKey, readKey, saveKey } from "./elevenlabs-key";

export const ELEVENLABS_API = "https://api.elevenlabs.io";
export const ELEVENLABS_SETTINGS = "Open Paseo Settings > Plugins and select the cog next to Read Aloud.";

export function elevenLabsError(status: number, body: string, apiKey: string, speech = false): Error {
  if (status === 429 || /quota[ _-]+exceeded/i.test(body)) {
    return new Error("ElevenLabs rate limit or quota reached");
  }
  if (status === 401) return new Error("ElevenLabs rejected the API key");
  if (status === 404 && speech) return new Error("ElevenLabs voice not found");
  const detail = body.replaceAll(apiKey, "[redacted]").trim().slice(0, 200);
  return new Error(`ElevenLabs request failed (${status})${detail ? ": " + detail : ""}`);
}

const voicePage = z.object({
  voices: z.array(z.object({
    voice_id: z.string(), name: z.string().nullish(), category: z.string().nullish(), description: z.string().nullish(),
  })),
  has_more: z.boolean().optional(),
  next_page_token: z.string().nullish(),
});

async function fetchVoicePage(apiKey: string, query: URLSearchParams) {
  const url = `${ELEVENLABS_API}/v2/voices?${query}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "xi-api-key": apiKey },
      // This is Node's fetch, despite React Native's global declarations.
      signal: AbortSignal.timeout(60_000) as RequestInit["signal"],
    });
  } catch {
    throw new Error("Could not reach ElevenLabs to look up voices");
  }
  if (!response.ok) throw elevenLabsError(response.status, await response.text().catch(() => ""), apiKey);
  const result = voicePage.safeParse(await response.json().catch(() => null));
  if (!result.success) throw new Error("ElevenLabs returned an invalid voice list");
  return result.data;
}

export function keyStatus() {
  const { source } = readKey();
  return { saved: source !== "none", source };
}

export async function validateAndSaveKey({ apiKey }: { apiKey: string }) {
  try {
    await fetchVoicePage(apiKey, new URLSearchParams({ page_size: "1" }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "ElevenLabs key validation failed" };
  }
  try {
    saveKey(apiKey);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the ElevenLabs API key on this host" };
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

export async function listVoices({ search }: { search?: string }) {
  const { apiKey } = readKey();
  if (!apiKey) throw new Error("No ElevenLabs API key is configured. " + ELEVENLABS_SETTINGS);
  const query = new URLSearchParams({ page_size: "100" });
  if (search?.trim()) query.set("search", search.trim());
  const voices = new Map<string, AccountVoice>();
  for (let page = 0; page < 5; page++) {
    const result = await fetchVoicePage(apiKey, query);
    for (const voice of result.voices) {
      voices.set(voice.voice_id, {
        id: voice.voice_id,
        name: voice.name || voice.voice_id,
        category: voice.category ?? "unknown",
        description: voice.description ?? undefined,
      });
    }
    if (result.has_more === false || !result.next_page_token) break;
    query.set("next_page_token", result.next_page_token);
  }
  return { voices: [...voices.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
