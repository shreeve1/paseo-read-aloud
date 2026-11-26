import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { googleClearKey, googleKeyStatus, googleSaveKey, googleVoices } from "./shared/google";
import {
  centralChunk, DIRECT_VOICE_UNAVAILABLE, endCentral, managedStatus, managedVoices, startCentral, type ManagedStatus,
} from "./shared/managed";
import { voiceSettings, type VoiceSettings } from "./shared/settings";
import { cancelSpeech, synthesizeSpeech, voiceStatus, type SpeechFile, type SpeechRequest, type VoiceStatus } from "./shared/speech";
import protocol from "./shared/hub-protocol-v1.json" with { type: "json" };
import { voiceModeConnect, voiceModeStatus } from "./shared/voice-mode";
import { createCentralPlayback } from "./server/central-playback";
import { HubError, loadMode, withLocalOption, type Mode } from "./server/managed";
import { isManagedSpeedAvailable, SPEED_UNAVAILABLE } from "./server/managed-speed";
import { addReadAloudRow } from "./server/reply-row";
import { startSpeechBridge } from "./server/speech-bridge";
import { cancel, checkVoice, disposeEngine, synthesize, synthesizeManaged } from "./server/tts";
import { keyStatus, listVoices, removeKey, validateAndSaveKey } from "./server/google";
import { createVoiceModeControls, restoreManagedSpeaking } from "./server/voice-mode";

type SpeechHandlers = {
  status(settings?: VoiceSettings): Promise<VoiceStatus>;
  synthesize(input: SpeechRequest, settings?: VoiceSettings): Promise<SpeechFile>;
  close?(): void | Promise<void>;
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
  const bridge = startSpeechBridge({ getSettings: async () => (await getSettings())?.google });
  const voiceMode = createVoiceModeControls({ bridge });
  server.handle(voiceModeStatus, (_input, { paseo }) => voiceMode.status(paseo.config));
  server.handle(voiceModeConnect, ({ enabled }, { paseo }) => voiceMode.connect(paseo.config, enabled));
  server.handle(googleKeyStatus, keyStatus);
  server.handle(googleSaveKey, validateAndSaveKey);
  server.handle(googleClearKey, removeKey);
  server.handle(googleVoices, listVoices);

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

function registerManaged(
  server: PluginServerContext, mode: Exclude<Mode, { kind: "personal" }>,
  getSettings: () => Promise<VoiceSettings | undefined>,
): SpeechHandlers {
  const central = mode.kind === "managed" && mode.standard ? createCentralPlayback(mode.hub, getSettings) : undefined;
  if (central) {
    server.handle(startCentral, central.start);
    server.handle(centralChunk, central.chunk);
    server.handle(endCentral, central.end);
  }
  // Tie denials to the saved selection, so a late response cannot invalidate a newer choice.
  const rejected = new WeakSet<VoiceSettings["managed"]>();
  server.handle(managedVoices, async () => {
    if (mode.kind !== "managed") throw new Error(mode.reason ?? HOST_NOT_MANAGED);
    return mode.hub.voices();
  });
  return {
    async status(settings) {
      if (mode.kind === "managed-local") return checkVoice(undefined, { localOnly: true });
      if (!central && settings?.provider === "google") return centralStatus(withLocalOption(DIRECT_VOICE_UNAVAILABLE));
      if (settings?.provider !== "managed") return checkVoice(undefined, { localOnly: true });
      if (mode.kind === "managed-unavailable") return centralStatus(mode.reason);
      if (!settings.managed.voiceId) return centralStatus(CHOOSE_CENTRAL_VOICE);
      const { voiceId, voiceName } = settings.managed;
      if (rejected.has(settings.managed)) {
        return { ...centralStatus(new HubError("voice_not_allowed").message, voiceName || "Central voice"), unavailableVoiceId: voiceId };
      }
      const status = centralStatus(undefined, voiceName || "Central voice");
      return central ? { ...status, standardPlayback: true } : status;
    },
    async synthesize(input, settings) {
      if (input.manual !== true || input.automatic || input.localOnly) throw new Error(MANUAL_PLAYBACK_ONLY);
      if (mode.kind === "managed-local") return synthesize({ ...input, localOnly: true });
      if (!central && settings?.provider === "google") throw new Error(withLocalOption(DIRECT_VOICE_UNAVAILABLE));
      if (settings?.provider !== "managed") return synthesize({ ...input, localOnly: true });
      if (mode.kind === "managed-unavailable") throw new Error(mode.reason);
      if (!settings.managed.voiceId) throw new Error(CHOOSE_CENTRAL_VOICE);
      if (protocol.pilot.fixture_only &&
          (input.text !== protocol.pilot.fixture_text || input.partial || input.previous || input.next)) {
        throw new HubError("text_not_allowed");
      }
      if (central && !input.preview) throw new Error(MANUAL_PLAYBACK_ONLY);
      if (rejected.has(settings.managed)) throw new HubError("voice_not_allowed");
      try {
        const { hub } = mode;
        const voice = settings.managed;
        return await (central
          ? central.exclusive(() => synthesizeManaged(hub, voice, { text: protocol.pilot.fixture_text }))
          : synthesizeManaged(hub, voice, input));
      } catch (error) {
        if (error instanceof HubError && error.code === "voice_not_allowed") rejected.add(settings.managed);
        throw error;
      }
    },
    close: central?.close,
  };
}

export function registerReadAloud(server: PluginServerContext, mode: Mode) {
  const settings = server.registerSettings(voiceSettings);
  let latest: VoiceSettings | undefined;
  let observed = false;
  const unsubscribe = settings.subscribe((state) => {
    observed = true;
    latest = state.status === "ready" ? state.values : undefined;
  });
  const initial = settings.read().then((state) => {
    if (!observed && state.status === "ready") latest = state.values;
  }, () => undefined);
  const getSettings = async () => {
    await initial;
    return latest;
  };
  const handlers = mode.kind === "personal" ? registerPersonal(server, getSettings) : registerManaged(server, mode, getSettings);

  let speakingRestore: Promise<string | undefined> | undefined;
  function checkSpeaking({ paseo }: PluginHandlerContext) {
    return speakingRestore ??= restoreManagedSpeaking(paseo.config).then((problem) => {
      if (problem) speakingRestore = undefined;
      return problem;
    });
  }

  const speedAvailable = mode.kind === "managed" ? isManagedSpeedAvailable() : undefined;
  server.handle(managedStatus, async (_input, context): Promise<ManagedStatus> => {
    if (mode.kind === "personal") return { mode: mode.kind };
    const speakingProblem = await checkSpeaking(context);
    if (mode.kind === "managed-unavailable") return { mode: mode.kind, reason: mode.reason, speakingProblem };
    if (mode.kind === "managed-local") return { mode: mode.kind, reason: mode.reason, speakingProblem };
    return { mode: mode.kind, standard: mode.standard, speakingProblem,
      speedProblem: await speedAvailable ? undefined : SPEED_UNAVAILABLE };
  });
  server.handle(synthesizeSpeech, async (input) => handlers.synthesize(input, await getSettings()));
  server.handle(cancelSpeech, cancel);
  server.handle(voiceStatus, async (_input, context) => {
    const speakingProblem = mode.kind === "personal" ? undefined : await checkSpeaking(context);
    const status = await handlers.status(await getSettings());
    return speakingProblem ? { ...status, speakingProblem } : status;
  });
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
