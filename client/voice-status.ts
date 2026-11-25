import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { managedStatus } from "../shared/managed";
import { voiceSettings } from "../shared/settings";
import { voiceStatus } from "../shared/speech";

export const voiceStatusQueryKey = ["read-aloud", "speech.status"] as const;

export function useManagedStatus(hostId: string) {
  const load = useRpc(managedStatus);
  return useQuery({
    queryKey: ["read-aloud", "managed.status", hostId],
    queryFn: () => load({}),
    refetchOnMount: "always",
    retry: false,
  });
}

export function useVoiceStatus(hostId: string) {
  const check = useRpc(voiceStatus);
  const settings = useSettings(voiceSettings);
  return useQuery({
    queryKey: [...voiceStatusQueryKey, hostId, settings.status === "ready" ? settings.revision : settings.status],
    queryFn: () => check({}),
    enabled: settings.status !== "loading",
    staleTime: 15_000,
    retry: false,
  });
}
