import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const managedStatus = defineRpc({
  name: "managed.status",
  input: z.object({}),
  output: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("personal") }),
    z.object({ mode: z.literal("managed"), speedProblem: z.string().optional(), speakingProblem: z.string().optional() }),
    z.object({ mode: z.literal("managed-unavailable"), reason: z.string(), speakingProblem: z.string().optional() }),
  ]),
});
export type ManagedStatus = z.output<typeof managedStatus.output>;

export const managedVoices = defineRpc({
  name: "managed.voices",
  input: z.object({}),
  output: z.object({ voices: z.array(z.object({ id: z.string(), name: z.string() })) }),
});

export const DIRECT_VOICE_UNAVAILABLE = "Direct Google voices are unavailable on this managed host. Choose Central voice.";
