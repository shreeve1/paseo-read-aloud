import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { voiceSettings } from "../shared/settings";
import { voiceStatus } from "../shared/speech";

export const voiceStatusQueryKey = ["read-aloud", "speech.status"] as const;

export function useVoiceStatus() {
  const check = useRpc(voiceStatus);
  const settings = useSettings(voiceSettings);
  return useQuery({
    queryKey: [...voiceStatusQueryKey, settings.status === "ready" ? settings.revision : settings.status],
    queryFn: () => check({}),
    enabled: settings.status !== "loading",
    staleTime: 15_000,
    retry: false,
  });
}
