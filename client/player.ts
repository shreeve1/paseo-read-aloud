import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { centralChunk, endCentral, startCentral } from "../shared/managed";
import { centralChunks } from "./central-chunks";
import { toChunks, toSpeech } from "../shared/text";
import type { SpeechFile, SpeechRequest } from "../shared/speech";

/**
 * Reads one reply at a time. Kept free of React and Paseo imports so it can be tested with a fake
 * host; the row component wires it to the real RPCs and audio queue.
 *
 * State lives here rather than in the rows: a chat list can unmount a row that scrolls out of view,
 * and reading should carry on (and show the right button when the row comes back).
 */

export type Phase = "idle" | "loading" | "playing" | "waiting" | "stopping";
export type AudioData = SpeechFile;

export interface PlayerHost {
  /** Generates one chunk. `session` groups one press's chunks so they can be cancelled together. */
  speak(input: SpeechRequest & { session: string }): Promise<AudioData>;
  /** Drops a personal or local session's queued chunks on the host. */
  cancel(session: string): Promise<unknown>;
  /** Paseo's shared audio queue: resolves when the clip finishes, cannot be interrupted. */
  playAudio(audio: AudioData): Promise<void>;
  central?: {
    start(input: RpcInput<typeof startCentral>): Promise<RpcOutput<typeof startCentral>>;
    chunk(input: RpcInput<typeof centralChunk>): Promise<RpcOutput<typeof centralChunk>>;
    end(input: RpcInput<typeof endCentral>): Promise<unknown>;
  };
}

export const PLAYER_DEFAULTS = {
  /** Chunks generated ahead of the one playing, so a slow chunk doesn't leave a gap. */
  lookahead: 2,
  /** Queue the next clip this long before the current one ends, so clips play back to back. */
  handoffMs: 250,
};

type Run = { key: string; session: string; stop: AbortController; cancel: () => void };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const newSession = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
function untilStop<T>(signal: AbortSignal, work: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const stopped = () => resolve(undefined);
    if (signal.aborted) stopped();
    else signal.addEventListener("abort", stopped, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped));
  });
}

function waitForRetry(signal: AbortSignal, seconds: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

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
    if (run.stop.signal.aborted) return;
    run.stop.abort();
    run.cancel();
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
    key: string, text: string, onError: (error: unknown) => void, agentId: string | undefined,
    usePrefetch: boolean, intent: { manual: true } | { automatic: true },
  ) {
    if (current) stopRun(current.run);
    const cached = usePrefetch ? warm.get(key) : undefined;
    warm.delete(key);
    // Each press gets its own run: a stopped press can never be revived by the next one.
    const session = cached?.session ?? newSession();
    const run: Run = {
      key,
      session,
      stop: new AbortController(),
      cancel: () => { void host.cancel(session).catch(() => undefined); },
    };
    current = { run, phase: "loading" };
    setPhase(run, "loading");

    const cleaned = toSpeech(text);
    const chunks = toChunks(cleaned);
    const pending: Promise<AudioData>[] = [];
    const request = (index: number) => {
      if (index >= chunks.length || index in pending) return;
      const input = chunkRequest(chunks, index, run.session, agentId);
      const speak = () => host.speak({
        ...input, ...intent, ...(input.text === cleaned ? {} : { partial: true }),
      });
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
        if (run.stop.signal.aborted) break;
        await handoff;
        if (run.stop.signal.aborted) break;
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
      if (!run.stop.signal.aborted) onError(error);
    } finally {
      // Show "stopping" until the clip already in Paseo's queue has actually finished.
      await queued;
      run.stop.abort();
      setPhase(run, "idle");
    }
  }

  async function playCentral(key: string, text: string, onError: (error: unknown) => void) {
    const central = host.central;
    if (!central) return;
    const cleaned = toSpeech(text);
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
    if (current) stopRun(current.run);
    const session = newSession();
    let permit: string | undefined;
    const release = () => {
      if (!permit) return;
      void central.end({ session, permit }).catch(() => undefined);
      permit = undefined;
    };
    const run: Run = { key, session, stop: new AbortController(), cancel: release };
    const { signal } = run.stop;
    current = { run, phase: "loading" };
    setPhase(run, "loading");
    let playing: Promise<void> | undefined;

    async function withRetry<T extends { kind: "ready" | "audio" }>(
      request: () => Promise<T | { kind: "wait"; seconds: number; message: string }>,
    ): Promise<T | undefined> {
      setPhase(run, playing ? "playing" : "loading");
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        const result = await untilStop(signal, request());
        if (!result || signal.aborted) return;
        if (result.kind !== "wait") return result;
        if (attempt === 1) throw new Error(result.message);
        setPhase(run, "waiting");
        await waitForRetry(signal, result.seconds);
        if (!signal.aborted) setPhase(run, playing ? "playing" : "loading");
      }
    }

    try {
      const authorized = await withRetry(async () => {
        const result = await central.start({ session });
        if (result.kind === "ready") {
          // Stop can win the race before the daemon issues a permit.
          if (signal.aborted) void central.end({ session, permit: result.permit }).catch(() => undefined);
          else permit = result.permit;
        }
        return result;
      });
      if (!authorized) return;
      const press = { session, permit: authorized.permit };
      for (const [index, chunk] of centralChunks(cleaned, authorized.voiceId).entries()) {
        const result = await withRetry(() => central.chunk({ ...press, index, text: chunk }));
        if (!result || signal.aborted) break;
        await playing;
        if (signal.aborted) break;
        setPhase(run, "playing");
        const clip = host.playAudio(result.audio).catch((error: unknown) => {
          if (!signal.aborted) onError(error);
          stopRun(run);
        });
        playing = clip;
        void clip.then(() => { if (playing === clip) playing = undefined; });
      }
    } catch (error) {
      if (!signal.aborted) onError(error);
    } finally {
      release();
      await playing;
      run.stop.abort();
      setPhase(run, "idle");
    }
  }

  return {
    playCentral,
    play(key: string, text: string, onError: (error: unknown) => void, agentId?: string, usePrefetch = true) {
      return play(key, text, onError, agentId, usePrefetch, { manual: true });
    },
    prefetch,
    autoPlay(key: string, text: string, createdAt: number | undefined, agentId: string, usePrefetch: boolean) {
      if (current || createdAt === undefined || Math.abs(Date.now() - createdAt) > AUTO_READ_WINDOW_MS || autoPlayed.has(key)) return;
      autoPlayed.add(key);
      return play(key, text, () => undefined, agentId, usePrefetch, { automatic: true });
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
