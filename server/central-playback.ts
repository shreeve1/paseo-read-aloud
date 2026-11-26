import { createHash, randomBytes } from "node:crypto";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { centralChunk, endCentral, startCentral } from "../shared/managed";
import type { VoiceSettings } from "../shared/settings";
import { HubError, withLocalOption, type HubClient } from "./managed";
import { isManagedSpeedAvailable, SPEED_UNAVAILABLE } from "./managed-speed";
import { synthesizeManaged } from "./tts";

const INACTIVITY_MS = 2 * 60_000;
const MAX_PRESS_MS = 60 * 60_000;
const MAX_ACTIVE_PRESSES = 32;
const NOT_AUTHORIZED = withLocalOption("Central voice has not been approved to read replies for this login. Settings can still play the fixed sample.");
const EXPIRED = withLocalOption("This Central voice playback ended. Press the speaker to start again.");
const SELECT_VOICE = withLocalOption("Choose a Central voice in Read Aloud settings before playing.");

type Selection = VoiceSettings["managed"];
type Press = {
  session: string;
  voice: Selection;
  deadline: number;
  expires: number;
  index: number;
  retry?: { digest: string; readyAt: number };
};

function rateWait(error: unknown) {
  if (error instanceof HubError && error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
    return { kind: "wait", seconds: error.retryAfterSeconds, message: error.message } satisfies RpcOutput<typeof startCentral>;
  }
}

export function createCentralPlayback(hub: HubClient, getSettings: () => Promise<VoiceSettings | undefined>) {
  // Paseo exposes no caller identity to RPC handlers. Only the client whose start call returns
  // the random capability can use it, and only with that press's session and voice selection.
  const presses = new Map<string, Press>();
  let occupied = false;
  let closed = false;

  async function exclusive<T>(request: () => Promise<T>): Promise<T> {
    if (closed) throw new Error(EXPIRED);
    if (occupied) throw new HubError("busy");
    occupied = true;
    try {
      return await request();
    } finally {
      occupied = false;
    }
  }

  async function selectedVoice(): Promise<Selection> {
    const settings = await getSettings();
    if (settings?.provider !== "managed" || !settings.managed.voiceId) throw new Error(SELECT_VOICE);
    return settings.managed;
  }

  function stillSelected(original: Selection, current: Selection) {
    return original.voiceId === current.voiceId && original.speed === current.speed;
  }

  function prune(now: number) {
    for (const [permit, press] of presses) {
      if (press.expires <= now || press.deadline <= now) presses.delete(permit);
    }
  }

  return {
    exclusive,
    async start({ session }: RpcInput<typeof startCentral>): Promise<RpcOutput<typeof startCentral>> {
      try {
        return await exclusive(async () => {
          prune(Date.now());
          if (presses.size >= MAX_ACTIVE_PRESSES || [...presses.values()].some((press) => press.session === session)) {
            throw new HubError("busy");
          }
          const voice = await selectedVoice();
          if (voice.speed !== 1 && !(await isManagedSpeedAvailable())) throw new Error(SPEED_UNAVAILABLE);
          const { reply_mode, voices } = await hub.voices();
          if (reply_mode !== "standard") throw new Error(NOT_AUTHORIZED);
          if (!voices.some(({ id }) => id === voice.voiceId)) throw new HubError("voice_not_allowed");
          const current = await selectedVoice();
          if (closed || !stillSelected(voice, current)) throw new Error(EXPIRED);
          const now = Date.now();
          const permit = randomBytes(32).toString("hex");
          presses.set(permit, { session, voice, deadline: now + MAX_PRESS_MS, expires: now + INACTIVITY_MS, index: 0 });
          return { kind: "ready", permit, voiceId: voice.voiceId };
        });
      } catch (error) {
        const wait = rateWait(error);
        if (wait) return wait;
        throw error;
      }
    },
    async chunk({ session, permit, index, text }: RpcInput<typeof centralChunk>): Promise<RpcOutput<typeof centralChunk>> {
      return exclusive(async () => {
        prune(Date.now());
        const press = presses.get(permit);
        if (!press || press.session !== session || press.index !== index) throw new Error(EXPIRED);
        const digest = createHash("sha256").update(text).digest("hex");
        const retry = press.retry;
        if (retry && (retry.digest !== digest || Date.now() < retry.readyAt)) throw new Error(EXPIRED);
        try {
          const voice = await selectedVoice();
          if (!stillSelected(press.voice, voice) || presses.get(permit) !== press) throw new Error(EXPIRED);
          const audio = await synthesizeManaged(hub, press.voice, { text });
          if (presses.get(permit) !== press) throw new Error(EXPIRED);
          press.index++;
          press.expires = Date.now() + INACTIVITY_MS;
          press.retry = undefined;
          return { kind: "audio", audio };
        } catch (error) {
          const wait = rateWait(error);
          if (wait && !retry && presses.get(permit) === press) {
            const now = Date.now();
            press.retry = { digest, readyAt: now + wait.seconds * 1000 };
            press.expires = now + INACTIVITY_MS;
            return wait;
          }
          presses.delete(permit);
          throw error;
        }
      });
    },
    end({ session, permit }: RpcInput<typeof endCentral>) {
      if (presses.get(permit)?.session !== session) return { ok: false };
      presses.delete(permit);
      return { ok: true };
    },
    close() {
      // An admitted hub request can finish. Keep the slot occupied until its response settles.
      closed = true;
      presses.clear();
    },
  };
}
