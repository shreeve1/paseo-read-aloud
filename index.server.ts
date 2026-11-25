import type { PluginServerContext } from "@getpaseo/plugin/server";
import { elevenLabsClearKey, elevenLabsKeyStatus, elevenLabsSaveKey, elevenLabsVoices } from "./shared/elevenlabs";
import { DIRECT_VOICE_UNAVAILABLE, managedStatus, managedVoices } from "./shared/managed";
import { voiceSettings, type VoiceSettings } from "./shared/settings";
import { cancelSpeech, synthesizeSpeech, voiceStatus, type SpeechFile, type SpeechRequest, type VoiceStatus } from "./shared/speech";
import { voiceModeConnect, voiceModeStatus } from "./shared/voice-mode";
import { loadMode, withLocalOption, type Mode } from "./server/managed";
import { addReadAloudRow } from "./server/reply-row";
import { startSpeechBridge } from "./server/speech-bridge";
import { cancel, checkVoice, disposeEngine, synthesize, synthesizeManaged } from "./server/tts";
import { keyStatus, listVoices, removeKey, validateAndSaveKey } from "./server/elevenlabs";
import { createVoiceModeControls } from "./server/voice-mode";

type SpeechHandlers = {
  status(settings?: VoiceSettings): Promise<VoiceStatus>;
  synthesize(input: SpeechRequest, settings?: VoiceSettings): Promise<SpeechFile>;
  close?(): Promise<void>;
};

const HOST_NOT_MANAGED = withLocalOption("This host is not configured for Central voice.");
const CHOOSE_CENTRAL_VOICE = withLocalOption("Choose a Central voice in Read Aloud settings before playing.");
const MANUAL_PLAYBACK_ONLY = withLocalOption("Automatic reading is off on this managed host. Press the speaker button to play.");

function centralStatus(problem?: string, voice = "Central voice"): VoiceStatus {
  return problem ? { ok: false, voice, provider: "managed", problem } : { ok: true, voice, provider: "managed" };
}

function registerPersonal(
  server: PluginServerContext, getSettings: () => Promise<VoiceSettings | undefined>,
): SpeechHandlers {
  const bridge = startSpeechBridge({ getSettings: async () => (await getSettings())?.elevenlabs });
  const voiceMode = createVoiceModeControls({ bridge });
  server.handle(voiceModeStatus, (_input, { paseo }) => voiceMode.status(paseo.config));
  server.handle(voiceModeConnect, ({ enabled }, { paseo }) => voiceMode.connect(paseo.config, enabled));
  server.handle(elevenLabsKeyStatus, keyStatus);
  server.handle(elevenLabsSaveKey, validateAndSaveKey);
  server.handle(elevenLabsClearKey, removeKey);
  server.handle(elevenLabsVoices, listVoices);

  return {
    async status(settings) {
      return settings?.provider === "managed" ? centralStatus(HOST_NOT_MANAGED) : checkVoice(settings);
    },
    async synthesize(input, settings) {
      if (settings?.provider === "managed") throw new Error(HOST_NOT_MANAGED);
      return synthesize(input, settings);
    },
    close: () => bridge.close(),
  };
}

function registerManaged(server: PluginServerContext, mode: Exclude<Mode, { kind: "personal" }>): SpeechHandlers {
  server.handle(managedVoices, async () => {
    if (mode.kind === "managed-unavailable") throw new Error(mode.reason);
    return mode.hub.voices();
  });
  return {
    async status(settings) {
      if (settings?.provider === "elevenlabs") return centralStatus(withLocalOption(DIRECT_VOICE_UNAVAILABLE));
      if (settings?.provider !== "managed") return checkVoice(undefined, { localOnly: true });
      if (mode.kind === "managed-unavailable") return centralStatus(mode.reason);
      if (!settings.managed.voiceId) return centralStatus(CHOOSE_CENTRAL_VOICE);
      return centralStatus(undefined, settings.managed.voiceName || "Central voice");
    },
    async synthesize(input, settings) {
      if (input.automatic || input.localOnly) throw new Error(MANUAL_PLAYBACK_ONLY);
      if (settings?.provider === "elevenlabs") throw new Error(withLocalOption(DIRECT_VOICE_UNAVAILABLE));
      if (settings?.provider !== "managed") return synthesize({ ...input, localOnly: true });
      if (mode.kind === "managed-unavailable") throw new Error(mode.reason);
      if (!settings.managed.voiceId) throw new Error(CHOOSE_CENTRAL_VOICE);
      return synthesizeManaged(mode.hub, settings.managed.voiceId, input);
    },
  };
}

export function registerReadAloud(server: PluginServerContext, mode: Mode) {
  const settings = server.registerSettings(voiceSettings);
  let latest: VoiceSettings | undefined;
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") latest = state.values;
  });
  const initial = settings.read().then((state) => {
    if (state.status === "ready") latest ??= state.values;
  }, () => undefined);
  const getSettings = async () => {
    await initial;
    return latest;
  };
  const handlers = mode.kind === "personal" ? registerPersonal(server, getSettings) : registerManaged(server, mode);

  server.handle(managedStatus, () => mode.kind === "managed-unavailable"
    ? { mode: mode.kind, reason: mode.reason }
    : { mode: mode.kind });
  server.handle(synthesizeSpeech, async (input) => handlers.synthesize(input, await getSettings()));
  server.handle(cancelSpeech, cancel);
  server.handle(voiceStatus, async () => handlers.status(await getSettings()));
  const removeHook = server.addHook("agent.turn.after", addReadAloudRow);
  return async () => {
    await handlers.close?.();
    await unsubscribe();
    if (typeof removeHook === "function") await removeHook();
    disposeEngine();
  };
}

export default function contribute(server: PluginServerContext) {
  return registerReadAloud(server, loadMode());
}
