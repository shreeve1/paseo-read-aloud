import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const voiceSettings = defineSettings({
  id: "voice",
  scope: "host",
  version: 1,
  schema: z.object({
    provider: z.enum(["paseo", "elevenlabs"]).default("paseo"),
    elevenlabs: z.object({
      voiceId: z.string().default(""),
      voiceName: z.string().default(""),
      model: z.string().default("eleven_flash_v2_5"),
      speed: z.number().min(0.7).max(1.2).default(1),
      agentVoices: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    }).prefault({}),
  }),
});
export type VoiceSettings = z.output<typeof voiceSettings.schema>;

export const deviceSettings = defineSettings({
  id: "device",
  scope: "device",
  version: 1,
  schema: z.object({ autoRead: z.boolean().default(false) }),
});
