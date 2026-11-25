import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const voiceModeStatus = defineRpc({
  name: "voice-mode.status",
  input: z.object({}),
  output: z.object({
    listening: z.boolean(),
    error: z.string().optional(),
    connected: z.boolean(),
    provider: z.string(),
  }),
});

export const voiceModeConnect = defineRpc({
  name: "voice-mode.connect",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});
