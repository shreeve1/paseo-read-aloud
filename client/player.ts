import { toChunks, toSpeech } from "../shared/text";
import type { SpeechFile, SpeechRequest } from "../shared/speech";

/**
 * Reads one reply at a time. Kept free of React and Paseo imports so it can be tested with a fake
 * host; the row component wires it to the real RPCs and audio queue.
 *
 * State lives here rather than in the rows: a chat list can unmount a row that scrolls out of view,
 * and reading should carry on (and show the right button when the row comes back).
 */

export type Phase = "idle" | "loading" | "playing" | "stopping";
export type AudioData = SpeechFile;

export interface PlayerHost {
  /** Generates one chunk. `session` groups one press's chunks so they can be cancelled together. */
  speak(input: SpeechRequest & { session: string }): Promise<AudioData>;
  /** Drops a session's queued chunks on the host. */
  cancel(session: string): Promise<unknown>;
  /** Paseo's shared audio queue: resolves when the clip finishes, cannot be interrupted. */
  playAudio(audio: AudioData): Promise<void>;
}

export const PLAYER_DEFAULTS = {
  /** Chunks generated ahead of the one playing, so a slow chunk doesn't leave a gap. */
  lookahead: 2,
  /** Queue the next clip this long before the current one ends, so clips play back to back. */
  handoffMs: 250,
};

type Run = { key: string; session: string; stopped: boolean };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const newSession = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const AUTO_READ_WINDOW_MS = 20_000;
const autoPlayed = new Set<string>();

function chunkRequest(chunks: string[], index: number, session: string, agentId?: string) {
  return { text: chunks[index], session, agentId, previous: chunks[index - 1], next: chunks[index + 1] };
}

export function createPlayer(host: PlayerHost, options = PLAYER_DEFAULTS) {
  let current: { run: Run; phase: Exclude<Phase, "idle"> } | null = null;
  const listeners = new Set<() => void>();
  /** Prepared first chunks, by row, so a press right after hover or touch-down speaks at once. */
  const warm = new Map<string, { session: string; first: Promise<AudioData | null> }>();

  function setPhase(run: Run, phase: Phase) {
    if (current && current.run !== run) return; // A newer press owns the player now.
    current = phase === "idle" ? null : { run, phase };
    for (const listener of listeners) listener();
  }

  function stopRun(run: Run) {
    if (run.stopped) return;
    run.stopped = true;
    // Drop the chunks still waiting on the host so the next press starts straight away.
    host.cancel(run.session).catch(() => undefined);
    if (current?.run === run) setPhase(run, "stopping");
  }

  function prefetch(key: string, text: string, agentId?: string) {
    if (warm.has(key)) return;
    const chunks = toChunks(toSpeech(text));
    if (!chunks.length) return;
    const session = newSession();
    const first = host.speak({ ...chunkRequest(chunks, 0, session, agentId), localOnly: true });
    warm.set(key, { session, first: first.catch(() => null) });
    if (warm.size > 20) warm.delete(warm.keys().next().value as string);
  }

  async function play(
    key: string, text: string, onError: (error: unknown) => void, agentId?: string, usePrefetch = true, automatic = false,
  ) {
    if (current) stopRun(current.run);
    const cached = usePrefetch ? warm.get(key) : undefined;
    warm.delete(key);
    // Each press gets its own run: a stopped press can never be revived by the next one.
    const run: Run = { key, session: cached?.session ?? newSession(), stopped: false };
    current = { run, phase: "loading" };
    setPhase(run, "loading");

    const chunks = toChunks(toSpeech(text));
    const pending: Promise<AudioData>[] = [];
    const request = (index: number) => {
      if (index >= chunks.length || index in pending) return;
      const input = chunkRequest(chunks, index, run.session, agentId);
      const speak = () => host.speak(automatic ? { ...input, automatic: true } : input);
      pending[index] = index === 0 && cached ? cached.first.then((audio) => audio ?? speak()) : speak();
      pending[index].catch(() => undefined);
    };

    // `queued` resolves when the last clip handed to Paseo finishes; `handoff` when it is nearly
    // done, which is when the next clip should join Paseo's queue.
    let queued: Promise<void> = Promise.resolve();
    let handoff: Promise<void> = Promise.resolve();
    try {
      for (let index = 0; index < chunks.length; index++) {
        for (let ahead = 0; ahead <= options.lookahead; ahead++) request(index + ahead);
        const audio = await pending[index];
        if (run.stopped) break;
        await handoff;
        if (run.stopped) break;
        setPhase(run, "playing");
        const started = queued;
        const done = host.playAudio(audio).catch(() => {
          // Browser autoplay rules, voice controls, or a reload can interrupt playback.
          stopRun(run);
        });
        queued = done;
        // Paseo's queue can't be cleared, so hand over one clip at a time, just before the
        // current one ends: playback stays gapless and a stop never has more than one clip left.
        const duration = audio.durationMs;
        handoff = duration === undefined ? done : Promise.race([done, started.then(() => delay(duration - options.handoffMs))]);
      }
    } catch (error) {
      if (!run.stopped) onError(error);
    } finally {
      // Show "stopping" until the clip already in Paseo's queue has actually finished.
      await queued;
      run.stopped = true;
      setPhase(run, "idle");
    }
  }

  return {
    play,
    prefetch,
    autoPlay(key: string, text: string, createdAt: number | undefined, agentId: string, usePrefetch: boolean) {
      if (current || createdAt === undefined || Math.abs(Date.now() - createdAt) > AUTO_READ_WINDOW_MS || autoPlayed.has(key)) return;
      autoPlayed.add(key);
      return play(key, text, () => undefined, agentId, usePrefetch, true);
    },
    /** Stops the reply with this key, if it is the one reading. */
    stop(key: string) {
      if (current?.run.key === key) stopRun(current.run);
    },
    phase(key: string): Phase {
      return current?.run.key === key ? current.phase : "idle";
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;
