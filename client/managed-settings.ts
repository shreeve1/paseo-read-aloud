import type { ManagedStatus } from "../shared/managed";
import type { VoiceSettings } from "../shared/settings";

const personalSources = [
  { value: "paseo", label: "Paseo voice settings" },
  { value: "google", label: "Google" },
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
  unavailableVoiceId?: string,
): VoiceSettings["managed"] {
  if (saved.voiceId && saved.voiceId === unavailableVoiceId) return { ...saved, voiceId: "", voiceName: "" };
  if (available === undefined) return saved;
  const voice = available.find(({ id }) => id === saved.voiceId);
  const voiceId = voice?.id ?? "";
  const voiceName = voice?.name ?? "";
  return voiceId === saved.voiceId && voiceName === saved.voiceName ? saved : { ...saved, voiceId, voiceName };
}

export function voicePickerOptions<T extends { id: string; name: string }>(
  available: readonly T[], selected: string, search: string,
) {
  const searchText = search.trim().toLowerCase();
  const matching = available.filter(({ name }) => name.toLowerCase().includes(searchText));
  const current = available.find(({ id }) => id === selected);
  const toOption = ({ id, name }: T) => ({ value: id, label: name });
  const options = matching.map(toOption);
  if (current && !matching.includes(current)) options.unshift(toOption(current));
  return { matching, options };
}
