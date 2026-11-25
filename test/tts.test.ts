import assert from "node:assert/strict";
import { test } from "node:test";
import { pcmClip, synthesize } from "../server/tts.ts";

test("PCM clips trim padding and report exact WAV duration", () => {
  const samples = new Float32Array(2000);
  samples.fill(-0.5, 500, 700);
  const clip = pcmClip(samples, 1000);
  const wav = Buffer.from(clip.base64, "base64");
  assert.equal(clip.durationMs, 350);
  assert.equal(wav.readUInt32LE(40), 700);
  assert.equal(wav.readInt16LE(44 + 2 * 29), 0);
  assert.equal(wav.readInt16LE(44 + 2 * 30), -16384);
});

test("OpenAI uses timed WAV and remembers a PCM format downgrade per endpoint", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = {
    PASEO_HOME: import.meta.dirname,
    PASEO_VOICE_TTS_PROVIDER: "openai",
    OPENAI_TTS_API_KEY: "fake-key",
    OPENAI_TTS_BASE_URL: "https://compatible.example/v1",
  };
  const formats: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    const { response_format: format } = JSON.parse(String(init.body));
    formats.push(format);
    if (format === "pcm" && url.includes("compatible.example")) {
      return Promise.resolve(new Response("Unsupported response_format: pcm", { status: 400 }));
    }
    const pcm = new Int16Array(240).fill(1000);
    return Promise.resolve(new Response(format === "pcm" ? pcm : "mp3"));
  });

  const first = await synthesize({ text: "Hello" });
  assert.equal(first.mimeType, "audio/mpeg");
  assert.equal(first.durationMs, undefined);
  await synthesize({ text: "Next" });
  assert.deepEqual(formats, ["pcm", "mp3", "mp3"]);
  await assert.rejects(() => synthesize({ text: "Touch only", localOnly: true }));
  assert.equal(formats.length, 3);

  process.env.OPENAI_TTS_BASE_URL = "https://another.example/v1";
  const clip = await synthesize({ text: "Hello" });
  assert.equal(formats.at(-1), "pcm");
  assert.equal(clip.mimeType, "audio/wav");
  assert.equal(clip.durationMs, 10);
  const wav = Buffer.from(clip.base64, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), 480);
  assert.equal(wav.readInt16LE(44), 1000);
});
