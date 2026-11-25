import type { PluginServerContext } from "@getpaseo/plugin/server";
import { elevenLabsClearKey, elevenLabsKeyStatus, elevenLabsSaveKey, elevenLabsVoices } from "./shared/elevenlabs";
import { voiceSettings, type VoiceSettings } from "./shared/settings";
import { cancelSpeech, synthesizeSpeech, voiceStatus } from "./shared/speech";
import { voiceModeConnect, voiceModeStatus } from "./shared/voice-mode";
import { addReadAloudRow } from "./server/reply-row";
import { startSpeechBridge } from "./server/speech-bridge";
import { cancel, checkVoice, disposeEngine, synthesize } from "./server/tts";
import { keyStatus, listVoices, removeKey, validateAndSaveKey } from "./server/elevenlabs";
import { createVoiceModeControls } from "./server/voice-mode";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(voiceSettings);
  let latest: VoiceSettings | undefined;
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") latest = state.values;
  });
  const initial = settings.read().then((state) => {
    if (state.status === "ready") latest ??= state.values;
  }, () => undefined);
  const bridge = startSpeechBridge({ getSettings: async () => {
    await initial;
    return latest?.elevenlabs;
  } });
  const voiceMode = createVoiceModeControls({ bridge });
  server.handle(voiceModeStatus, (_input, { paseo }) => voiceMode.status(paseo.config));
  server.handle(voiceModeConnect, ({ enabled }, { paseo }) => voiceMode.connect(paseo.config, enabled));
  server.handle(synthesizeSpeech, async (input) => {
    await initial;
    return synthesize(input, latest);
  });
  server.handle(cancelSpeech, cancel);
  server.handle(voiceStatus, async () => {
    await initial;
    return checkVoice(latest);
  });
  server.handle(elevenLabsKeyStatus, keyStatus);
  server.handle(elevenLabsSaveKey, validateAndSaveKey);
  server.handle(elevenLabsClearKey, removeKey);
  server.handle(elevenLabsVoices, listVoices);
  const removeHook = server.addHook("agent.turn.after", addReadAloudRow);
  return async () => {
    await bridge.close();
    await unsubscribe();
    if (typeof removeHook === "function") await removeHook();
    disposeEngine();
  };
}
