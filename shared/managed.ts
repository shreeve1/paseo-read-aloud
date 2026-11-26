import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { speechFile } from "./speech";

export const replyMode = z.enum(["pilot", "standard"]);
export const retryAfter = z.number().int().min(1).max(60);

export const managedStatus = defineRpc({
  name: "managed.status",
  input: z.object({}),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("personal") }),
    z.object({ mode: z.literal("managed"), standard: z.literal(true).optional(), speedProblem: z.string().optional(), speakingProblem: z.string().optional() }),
    z.object({ mode: z.literal("managed-local"), reason: z.string().optional(), speakingProblem: z.string().optional() }),
    z.object({ mode: z.literal("managed-unavailable"), reason: z.string(), speakingProblem: z.string().optional() }),
  ]),
});
export type ManagedStatus = z.output<typeof managedStatus.output>;

export const managedVoices = defineRpc({
  name: "managed.voices",
  input: z.object({}),
  output: z.object({ voices: z.array(z.object({ id: z.string(), name: z.string() })), reply_mode: replyMode.optional() }),
});

export const DIRECT_VOICE_UNAVAILABLE = "Direct Google voices are unavailable on this managed host. Choose Central voice.";

const centralSession = z.string().min(1).max(100);
const centralPermit = z.string().regex(/^[a-f0-9]{64}$/);
const rateWait = z.object({ kind: z.literal("wait"), seconds: retryAfter, message: z.string() });

export const startCentral = defineRpc({
  name: "managed.start",
  input: z.object({ session: centralSession }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready"), permit: centralPermit, voiceId: z.string() }),
    rateWait,
  ]),
});

const press = z.object({ session: centralSession, permit: centralPermit });

export const centralChunk = defineRpc({
  name: "managed.chunk",
  input: press.extend({ index: z.number().int().nonnegative(), text: z.string().min(1).max(500) }),
  output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("audio"), audio: speechFile }), rateWait]),
});

export const endCentral = defineRpc({
  name: "managed.end",
  input: press,
  output: z.object({ ok: z.boolean() }),
});
