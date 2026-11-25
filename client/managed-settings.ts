import type { ManagedStatus } from "../shared/managed";
import type { VoiceSettings } from "../shared/settings";

const personalSources = [
  { value: "paseo", label: "Paseo voice settings" },
  { value: "elevenlabs", label: "ElevenLabs" },
] as const;
const managedSources = [
  { value: "paseo", label: "Paseo voice settings (local)" },
  { value: "managed", label: "Central voice" },
] as const;

export function voiceSources(mode: ManagedStatus["mode"]) {
  return mode === "personal" ? personalSources : managedSources;
}

export function shouldAutoRead(mode: ManagedStatus["mode"] | undefined, enabled: boolean): boolean {
  return mode === "personal" && enabled;
}

export function reconcileManagedVoice(
  saved: VoiceSettings["managed"], available: readonly { id: string; name: string }[] | undefined,
): VoiceSettings["managed"] {
  if (available === undefined) return saved;
  const voice = available.find(({ id }) => id === saved.voiceId);
  const voiceId = voice?.id ?? "";
  const voiceName = voice?.name ?? "";
  return voiceId === saved.voiceId && voiceName === saved.voiceName ? saved : { voiceId, voiceName };
}
