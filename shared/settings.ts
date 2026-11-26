import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_GOOGLE_VOICE } from "./google";

// Only used to recognize the retired direct provider in version-1 settings.
const legacyDirectProvider = "ele" + "venlabs";

export const VOICE_SPEEDS = [0.5, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2] as const;
export const managedSpeed = z.literal(VOICE_SPEEDS);
export type ManagedSpeed = z.output<typeof managedSpeed>;

export const voiceSettings = defineSettings({
  id: "voice",
  scope: "host",
  version: 2,
  schema: z.object({
    provider: z.enum(["paseo", "google", "managed"]).default("paseo"),
    managed: z.object({
      voiceId: z.string().default(""),
      voiceName: z.string().default(""),
      speed: managedSpeed.default(1),
    }).prefault({}),
    google: z.object({
      voiceName: z.string().default(DEFAULT_GOOGLE_VOICE),
      voiceLabel: z.string().default("Charon"),
      speed: z.number().min(0.5).max(2).default(1),
      agentVoices: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    }).prefault({}),
  }),
  migrate(values, fromVersion) {
    if (fromVersion !== 1) throw new Error("Unsupported voice settings version.");
    const { provider, managed } = z.object({ provider: z.string().optional(), managed: z.unknown().optional() }).parse(values);
    return { provider: provider === legacyDirectProvider ? "google" : provider, managed };
  },
});
export type VoiceSettings = z.output<typeof voiceSettings.schema>;

export const deviceSettings = defineSettings({
  id: "device",
  scope: "device",
  version: 1,
  schema: z.object({ autoRead: z.boolean().default(false) }),
});
