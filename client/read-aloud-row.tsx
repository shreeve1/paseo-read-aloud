import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { centralChunk, endCentral, startCentral } from "../shared/managed";
import { deviceSettings } from "../shared/settings";
import { cancelSpeech, readAloudSchema, synthesizeSpeech } from "../shared/speech";
import { createPlayer, type Phase, type Player } from "./player";
import { shouldAutoRead } from "./managed-settings";
import { useManagedStatus, useVoiceStatus } from "./voice-status";

type Props = PluginTimelineItemProps<z.output<typeof readAloudSchema>>;

/** Hovering this long counts as intent to press; shorter passes over the button cost nothing. */
const HOVER_PREFETCH_MS = 250;

function usePhase(player: Player, key: string): Phase {
  return useSyncExternalStore(player.subscribe, () => player.phase(key));
}

export function createReadAloudRow(client: PluginClientContext) {
  const player = createPlayer({
    speak: (input) => client.rpc(synthesizeSpeech, input),
    cancel: (session) => client.rpc(cancelSpeech, { session }),
    playAudio: (audio) => client.playAudio(audio),
    central: {
      start: (input) => client.rpc(startCentral, input),
      chunk: (input) => client.rpc(centralChunk, input),
      end: (input) => client.rpc(endCentral, input),
    },
  });

  return function ReadAloudRow({ agentId, host, item, timestamp, theme }: Props) {
    // Stable across remounts, so a row scrolled back into view shows the reading in progress.
    const rowId = "id" in item && typeof item.id === "string" ? item.id : timestamp.getTime();
    const key = `${host.id}:${agentId}:${rowId}`;
    const phase = usePhase(player, key);
    const [hovered, setHovered] = useState(false);
    const [pinned, setPinned] = useState(false);
    const { data: voice, refetch } = useVoiceStatus(host.id);
    const modeStatus = useManagedStatus(host.id);
    const mode = modeStatus.isSuccess && modeStatus.isFetchedAfterMount ? modeStatus.data.mode : undefined;
    const device = useSettings(deviceSettings);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toast = useToast();
    useEffect(
      () => () => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
      },
      [],
    );

    const broken = voice?.ok === false;
    const canPrefetch = mode === "personal" && voice?.provider === "local";
    const autoRead = shouldAutoRead(mode, device.status === "ready" && device.values.autoRead);
    const busy = phase !== "idle";
    const showHelp = broken && (pinned || hovered);
    const muted = theme.colors.foregroundMuted;

    useEffect(() => {
      if (autoRead && !broken) void player.autoPlay(key, item.data.text, item.data.createdAt, agentId, canPrefetch);
    }, [autoRead, broken, canPrefetch, key, item.data.text, item.data.createdAt, agentId]);

    function onError(error: unknown) {
      // Show the warning with fix-up steps if the voice is the problem; otherwise a toast.
      void refetch().then(({ data }) => {
        if (data?.ok !== false) toast.error(error instanceof Error ? error.message : "Read aloud failed");
        else setPinned(true);
      });
    }

    const label = {
      idle: broken ? "Read aloud unavailable. Show how to fix it" : "Read aloud",
      loading: "Stop reading",
      waiting: "Stop reading; waiting for Central voice",
      playing: "Stop reading",
      stopping: "Stopping",
    }[phase];
    const icon = {
      idle: broken ? "TriangleAlert" : "Volume2",
      loading: "LoaderCircle",
      waiting: "LoaderCircle",
      playing: "Square",
      stopping: "Square",
    }[phase] satisfies ComponentProps<typeof Icon>["name"];

    return (
      <View style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ busy: phase === "loading" || phase === "waiting" || phase === "stopping", disabled: phase === "stopping" }}
          disabled={phase === "stopping"}
          hitSlop={8}
          onPressIn={() => {
            if (!broken && !busy && canPrefetch) player.prefetch(key, item.data.text, agentId);
          }}
          onPress={() => {
            if (busy) player.stop(key);
            else if (broken) {
              setPinned((open) => !open);
              void refetch();
            } else if (voice?.standardPlayback) void player.playCentral(key, item.data.text, onError);
            else void player.play(key, item.data.text, onError, agentId, canPrefetch);
          }}
          onHoverIn={() => {
            setHovered(true);
            // Only local voices can be prefetched without a paid request.
            if (broken || busy || !canPrefetch) return;
            hoverTimer.current = setTimeout(() => player.prefetch(key, item.data.text, agentId), HOVER_PREFETCH_MS);
          }}
          onHoverOut={() => {
            setHovered(false);
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }}
          style={({ pressed }) => ({
            paddingHorizontal: 8,
            paddingVertical: 4,
            marginHorizontal: -8,
            borderRadius: 8,
            opacity: phase === "stopping" ? 0.4 : pressed ? 0.6 : 1,
          })}
        >
          <Icon
            name={icon}
            size={14}
            color={broken ? theme.colors.statusDanger : busy || hovered ? theme.colors.foreground : muted}
          />
        </Pressable>
        {phase === "waiting" ? (
          <Text accessibilityLiveRegion="polite" style={{ color: muted, fontSize: 12 }}>Waiting for Central voice…</Text>
        ) : null}
        {showHelp && voice ? (
          <View
            style={{
              marginTop: 4,
              maxWidth: 360,
              padding: 10,
              gap: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.statusDanger,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Read aloud can't speak yet</Text>
            {voice.problem ? <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{voice.problem}</Text> : null}
            {(voice.steps ?? []).map((step, index) => (
              <Text key={index} style={{ color: muted, fontSize: 12 }}>
                {index + 1}. {step}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    );
  };
}
