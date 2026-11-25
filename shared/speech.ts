import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export { MAX_SPOKEN_CHARS, toChunks, toSpeech } from "./text";

/**
 * Renders one chunk of speakable text to an audio file with the configured voice.
 * `session` groups the chunks of one press so a stop can drop the ones still waiting.
 * `durationMs` is set for WAV clips so the player can queue the next clip in time.
 */
export const synthesizeSpeech = defineRpc({
  name: "speech.synthesize",
  input: z.object({
    text: z.string().min(1).max(2000),
    session: z.string().max(100).optional(),
    agentId: z.string().optional(),
    previous: z.string().max(1000).optional(),
    next: z.string().max(1000).optional(),
    localOnly: z.boolean().optional(),
    automatic: z.boolean().optional(),
    manual: z.boolean().optional(),
    partial: z.literal(true).optional(),
  }),
  output: z.object({ base64: z.string(), mimeType: z.string(), durationMs: z.number().optional() }),
});
export type SpeechRequest = z.output<typeof synthesizeSpeech.input>;
export type SpeechFile = z.output<typeof synthesizeSpeech.output>;

/** Drops a session's queued chunks and aborts its in-flight network requests. */
export const cancelSpeech = defineRpc({
  name: "speech.cancel",
  input: z.object({ session: z.string().max(100) }),
  output: z.object({ ok: z.boolean() }),
});

/** Whether the voice Paseo would use can speak right now, with fix-up steps when it can't. */
export const voiceStatus = defineRpc({
  name: "speech.status",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    voice: z.string(),
    provider: z.enum(["local", "openai", "elevenlabs", "managed", "unknown"]).optional(),
    problem: z.string().optional(),
    unavailableVoiceId: z.string().optional(),
    speakingProblem: z.string().optional(),
    steps: z.array(z.string()).optional(),
  }),
});
export type VoiceStatus = z.output<typeof voiceStatus.output>;

/** Timeline row added under each finished reply. */
export const READ_ALOUD_KIND = "read-aloud";
export const readAloudSchema = z.object({ text: z.string(), createdAt: z.number().optional() });
