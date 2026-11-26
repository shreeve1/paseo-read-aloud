import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_GOOGLE_VOICE = "en-US-Chirp3-HD-Charon";
export const GOOGLE_VOICE_NAME = /^([a-z]{2,3}-[a-z0-9]{2,3})-Chirp3-HD-(\w+)$/i;
const googleVoice = z.object({ id: z.string(), name: z.string() });

export const googleKeyStatus = defineRpc({
  name: "google.key-status",
  input: z.object({}),
  output: z.object({ saved: z.boolean(), source: z.enum(["env", "file", "none"]) }),
});

export const googleSaveKey = defineRpc({
  name: "google.save-key",
  input: z.object({ apiKey: z.string().trim().min(1).max(1000) }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});

export const googleClearKey = defineRpc({
  name: "google.clear-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export const googleVoices = defineRpc({
  name: "google.voices",
  input: z.object({}),
  output: z.object({ voices: z.array(googleVoice) }),
});
