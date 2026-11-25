import type { PluginServerContext } from "@getpaseo/plugin/server";
import { elevenLabsClearKey, elevenLabsKeyStatus, elevenLabsSaveKey, elevenLabsVoices } from "./shared/elevenlabs";
import { voiceSettings, type VoiceSettings } from "./shared/settings";
import { cancelSpeech, synthesizeSpeech, voiceStatus } from "./shared/speech";
import { addReadAloudRow } from "./server/reply-row";
import { cancel, checkVoice, disposeEngine, synthesize } from "./server/tts";
import { keyStatus, listVoices, removeKey, validateAndSaveKey } from "./server/elevenlabs";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(voiceSettings);
  let latest: VoiceSettings | undefined;
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") latest = state.values;
  });
  const initial = settings.read().then((state) => {
    if (state.status === "ready") latest ??= state.values;
  }, () => undefined);
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
    await unsubscribe();
    if (typeof removeHook === "function") await removeHook();
    disposeEngine();
  };
}
