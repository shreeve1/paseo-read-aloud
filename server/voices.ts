/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import type { VoiceSettings } from "../shared/settings";
import { readKey } from "./elevenlabs-key";
import { paseoHome } from "./paths";

/**
 * Picks the same voice Paseo's voice mode uses, in Paseo's own order:
 * environment variables, then Settings > Voice (config.json), then Paseo's default.
 */

export type EngineFamily = "kokoro" | "kitten" | "vits";

export interface TtsEngine {
  family: EngineFamily;
  model: string;
  voices?: string;
  tokens: string;
  dataDir?: string;
  lexicons?: string[];
  dictDir?: string;
  ruleFsts?: string[];
}

interface VoiceSpec {
  label: string;
  extractedDir: string;
  engine: TtsEngine;
}

export type ResolvedVoice =
  | { provider: "local"; modelId: string; label: string; dir: string; engine: TtsEngine; speakerId: number; speed: number }
  | { provider: "openai"; apiKey?: string; endpoint: string; model: string; voice: string }
  | { provider: "elevenlabs"; apiKey?: string; voiceId: string; voiceName: string; model: string; speed: number };

const DEFAULT_LOCAL_TTS_MODEL = "kokoro-en-v0_19";

function piper(extractedDir: string, voice: string, label: string): VoiceSpec {
  return { label, extractedDir, engine: { family: "vits", model: `${voice}.onnx`, tokens: "tokens.txt", dataDir: "espeak-ng-data" } };
}

/** Copy of the TTS part of Paseo 0.15.4's speech model catalog, used if the live one can't be read. */
const BUILT_IN_CATALOG: Record<string, VoiceSpec> = {
  "kokoro-en-v0_19": {
    label: "Kokoro (English)",
    extractedDir: "kokoro-en-v0_19",
    engine: { family: "kokoro", model: "model.onnx", voices: "voices.bin", tokens: "tokens.txt", dataDir: "espeak-ng-data" },
  },
  "kokoro-int8-en-v0_19": {
    label: "Kokoro Lite (English)",
    extractedDir: "kokoro-int8-en-v0_19",
    engine: { family: "kokoro", model: "model.int8.onnx", voices: "voices.bin", tokens: "tokens.txt", dataDir: "espeak-ng-data" },
  },
  "kokoro-int8-multi-lang-v1_1": {
    label: "Kokoro (Chinese and English)",
    extractedDir: "kokoro-int8-multi-lang-v1_1",
    engine: {
      family: "kokoro",
      model: "model.int8.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
      lexicons: ["lexicon-us-en.txt", "lexicon-zh.txt"],
      dictDir: "dict",
      ruleFsts: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"],
    },
  },
  "kitten-nano-en-v0_2-fp16": {
    label: "Kitten Nano (English)",
    extractedDir: "kitten-nano-en-v0_2-fp16",
    engine: { family: "kitten", model: "model.fp16.onnx", voices: "voices.bin", tokens: "tokens.txt", dataDir: "espeak-ng-data" },
  },
  "piper-en-us-libritts-r": piper("vits-piper-en_US-libritts_r-medium-int8", "en_US-libritts_r-medium", "Piper LibriTTS (US English)"),
  "piper-en-gb-alba": piper("vits-piper-en_GB-alba-medium-int8", "en_GB-alba-medium", "Piper Alba (British English)"),
  "piper-de-thorsten": piper("vits-piper-de_DE-thorsten-medium-int8", "de_DE-thorsten-medium", "Piper Thorsten (German)"),
  "piper-fr-siwis": piper("vits-piper-fr_FR-siwis-medium-int8", "fr_FR-siwis-medium", "Piper Siwis (French)"),
  "piper-es-davefx": piper("vits-piper-es_ES-davefx-medium-int8", "es_ES-davefx-medium", "Piper Davefx (Spanish)"),
};

type LiveCatalog = {
  SHERPA_ONNX_MODEL_CATALOG?: Record<string, { kind?: string; label?: string; extractedDir?: string; engine?: TtsEngine; defaultFor?: string }>;
  DEFAULT_LOCAL_TTS_MODEL?: string;
};

let liveCatalog: LiveCatalog | null | undefined;

/**
 * Paseo's own catalog, read from the installed app so newly added voices work without a plugin
 * update. Plugin processes run Paseo's plugin-process.js, which sits beside the speech modules.
 */
function readLiveCatalog(): LiveCatalog | null {
  if (liveCatalog !== undefined) return liveCatalog;
  liveCatalog = null;
  try {
    const entry = process.argv[1] ?? "";
    const file = path.resolve(path.dirname(entry), "../speech/providers/local/sherpa/model-catalog.js");
    if (entry.includes(`${path.sep}@getpaseo${path.sep}server${path.sep}`) && fs.existsSync(file)) {
      liveCatalog = require(file) as LiveCatalog;
    }
  } catch {
    liveCatalog = null;
  }
  return liveCatalog;
}

function lookupVoice(modelId: string): VoiceSpec | undefined {
  const live = readLiveCatalog()?.SHERPA_ONNX_MODEL_CATALOG?.[modelId];
  if (live?.kind === "tts" && live.extractedDir && live.engine) {
    return { label: live.label ?? modelId, extractedDir: live.extractedDir, engine: live.engine };
  }
  return BUILT_IN_CATALOG[modelId];
}

function defaultModelId(): string {
  return readLiveCatalog()?.DEFAULT_LOCAL_TTS_MODEL ?? DEFAULT_LOCAL_TTS_MODEL;
}

export type DaemonConfig = {
  features?: { voiceMode?: { tts?: Record<string, unknown> } };
  providers?: { local?: { modelsDir?: unknown } };
  plugins?: Record<string, { path?: unknown; enabled?: unknown } | undefined>;
};

/** The daemon config file. Read directly: server code is trusted, and config.get() masks API keys. */
export function readDaemonConfig(home = paseoHome()): DaemonConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as DaemonConfig;
  } catch {
    return {};
  }
}

function first(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveOpenAiTtsKey(config: DaemonConfig, env: NodeJS.ProcessEnv) {
  const tts = config?.features?.voiceMode?.tts;
  return first(tts?.provider === "openai" ? tts.apiKey : undefined, env.OPENAI_TTS_API_KEY, env.OPENAI_API_KEY);
}

export function pickAgentVoice({ voiceId, voiceName, agentVoices }: VoiceSettings["elevenlabs"], agentId?: string) {
  const main = { id: voiceId, name: voiceName };
  if (!voiceId || !agentId || !agentVoices.length) return main;
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (Math.imul(31, hash) + agentId.charCodeAt(i)) >>> 0;
  return [main, ...agentVoices][hash % (agentVoices.length + 1)];
}

/** The plugin's ElevenLabs selection takes precedence over Paseo's speech settings. */
export function resolveVoice(
  { env = process.env, config, settings, agentId }: {
    env?: NodeJS.ProcessEnv; config?: DaemonConfig; settings?: VoiceSettings; agentId?: string;
  } = {},
): ResolvedVoice {
  if (settings?.provider === "elevenlabs") {
    const { id: voiceId, name: voiceName } = pickAgentVoice(settings.elevenlabs, agentId);
    return {
      provider: "elevenlabs", apiKey: readKey(env).apiKey, voiceId, voiceName,
      model: settings.elevenlabs.model, speed: settings.elevenlabs.speed,
    };
  }
  config ??= readDaemonConfig();
  const tts = config.features?.voiceMode?.tts ?? {};
  const provider = first(env.PASEO_VOICE_TTS_PROVIDER, tts.provider) ?? "local";

  if (provider === "openai") {
    const openai = tts.provider === "openai" ? tts : {};
    // Same base URL convention as Paseo's OpenAI client: it already ends in /v1.
    const baseUrl = first(openai.baseUrl, env.OPENAI_TTS_BASE_URL, env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1";
    return {
      provider: "openai",
      apiKey: resolveOpenAiTtsKey(config, env),
      endpoint: baseUrl.replace(/\/+$/, "") + "/audio/speech",
      model: first(env.TTS_MODEL, openai.model) ?? "tts-1",
      voice: first(env.TTS_VOICE, openai.voice) ?? "alloy",
    };
  }
  if (provider !== "local") {
    throw new Error(`Paseo's text-to-speech provider '${provider}' isn't supported by Read Aloud.`);
  }

  const local = tts.provider === "local" ? tts : {};
  const modelId = (first(env.PASEO_VOICE_LOCAL_TTS_MODEL, local.model) ?? defaultModelId()).toLowerCase();
  const spec = lookupVoice(modelId);
  if (!spec) throw new Error(`Paseo's voice '${modelId}' isn't one Read Aloud knows how to load.`);
  const modelsDir =
    first(env.PASEO_LOCAL_MODELS_DIR, config.providers?.local?.modelsDir) ?? path.join(paseoHome(), "models", "local-speech");
  const speakerId = Number(first(env.PASEO_VOICE_LOCAL_TTS_SPEAKER_ID, local.speakerId) ?? 0);
  const speed = Number(first(env.PASEO_VOICE_LOCAL_TTS_SPEED, local.speed) ?? 1);
  return {
    provider: "local",
    modelId,
    label: spec.label,
    dir: path.join(modelsDir, spec.extractedDir),
    engine: spec.engine,
    speakerId: Number.isInteger(speakerId) ? speakerId : 0,
    speed: Number.isFinite(speed) && speed > 0 ? speed : 1,
  };
}

/** Every file the voice needs, as Paseo's downloader checks them. */
export function requiredFiles(engine: TtsEngine): string[] {
  return Object.entries(engine).flatMap(([key, value]) =>
    key === "family" ? [] : typeof value === "string" ? [value] : Array.isArray(value) ? value : [],
  );
}
