import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const elevenLabsKeyStatus = defineRpc({
  name: "elevenlabs.key-status",
  input: z.object({}),
  output: z.object({ saved: z.boolean(), source: z.enum(["env", "file", "none"]) }),
});

export const elevenLabsSaveKey = defineRpc({
  name: "elevenlabs.save-key",
  input: z.object({ apiKey: z.string().trim().min(1).max(1000) }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

export const elevenLabsClearKey = defineRpc({
  name: "elevenlabs.clear-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

const accountVoice = z.object({
  id: z.string(), name: z.string(), category: z.string(), description: z.string().optional(),
});
export type AccountVoice = z.output<typeof accountVoice>;

export const elevenLabsVoices = defineRpc({
  name: "elevenlabs.voices",
  input: z.object({ search: z.string().max(200).optional() }),
  output: z.object({ voices: z.array(accountVoice) }),
});
