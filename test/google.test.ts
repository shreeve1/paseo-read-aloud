import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { GoogleSpeechError, keyStatus, listVoices, removeKey, validateAndSaveKey } from "../server/google.ts";
import { cancel, checkVoice, pcmClip, requestGoogle, synthesize } from "../server/tts.ts";
import { pickAgentVoice, resolveVoice } from "../server/voices.ts";
import { voiceSettings } from "../shared/settings.ts";

const apiKey = "fake-google-key";
const charon = "en-US-Chirp3-HD-Charon";
const kore = "en-US-Chirp3-HD-Kore";
const googleVoice = { apiKey, voiceName: charon, speed: 1.1 };
const settings = voiceSettings.schema.parse({
  provider: "google",
  google: { voiceName: charon, voiceLabel: "Charon", speed: 1.1, agentVoices: [{ id: kore, name: "Kore" }] },
});
const request = { text: "Hello", format: "LINEAR16" } as const;
const fakeAudio = "AAAHew==";
function googleFailure(code: number, status: string, reason?: string) {
  return Response.json({
    error: { code, status, message: "Upstream error: " + apiKey, details: reason ? [{ reason }] : [] },
  }, { status: code });
}

test("version 1 settings migrate James's saved selection to Google defaults", async () => {
  const stored = JSON.parse('{"version":1,"values":{"provider":"\\u0065levenlabs","\\u0065levenlabs":{"voiceId":"CwhRBWXzGAHq8TQ4Fs17","voiceName":"Roger","speed":1.2,"agentVoices":[{"id":"old","name":"Old"}]}}}');
  assert.ok(voiceSettings.migrate);
  assert.equal(voiceSettings.version, 2);
  const migrated = await voiceSettings.migrate(stored.values, stored.version);
  assert.deepEqual(voiceSettings.schema.parse(migrated), {
    provider: "google",
    managed: { voiceId: "", voiceName: "" },
    google: { voiceName: charon, voiceLabel: "Charon", speed: 1, agentVoices: [] },
  });
  for (const provider of ["paseo", "managed"]) {
    const managed = { voiceId: "central", voiceName: "Central" };
    const values = await voiceSettings.migrate({ ...stored.values, provider, managed }, stored.version);
    const parsed = voiceSettings.schema.parse(values);
    assert.equal(parsed.provider, provider);
    assert.deepEqual(parsed.managed, managed);
  }
});

test("Google's direct voice takes priority and per-agent choices stay stable", () => {
  const env = { PASEO_VOICE_TTS_PROVIDER: "openai", GOOGLE_TTS_API_KEY: apiKey };
  const pool = settings.google;
  const picks = Array.from({ length: 10 }, (_, i) => pickAgentVoice(pool, "agent-" + i));
  assert.deepEqual(new Set(picks.map(({ id }) => id)), new Set([charon, kore]));
  for (const [i, pick] of picks.entries()) assert.deepEqual(pickAgentVoice(pool, "agent-" + i), pick);
  assert.deepEqual(pickAgentVoice(pool), { id: charon, name: "Charon" });
  assert.deepEqual(pickAgentVoice({ ...pool, agentVoices: [] }, "agent-1"), { id: charon, name: "Charon" });
  assert.deepEqual(resolveVoice({ env, config: {}, settings }), {
    provider: "google", ...googleVoice, voiceLabel: "Charon",
  });
  assert.equal(resolveVoice({ env, config: {}, settings: voiceSettings.schema.parse({}) }).provider, "openai");
  assert.throws(() => resolveVoice({ env, settings, localOnly: true }), /Only local/);
});

test("requestGoogle sends the key in the header and applies the voice locale and speaking rate", async (t) => {
  const fetchSpeech = t.mock.fn<typeof fetch>(async (url, init) => {
    assert.equal(url, "https://texttospeech.googleapis.com/v1/text:synthesize");
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Goog-Api-Key"), apiKey);
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      input: { text: "Hello" },
      voice: { languageCode: "fr-FR", name: "fr-FR-Chirp3-HD-Charon" },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24_000, speakingRate: 1.1 },
    });
    return Response.json({ audioContent: fakeAudio });
  });
  const audio = await requestGoogle({ ...googleVoice, voiceName: "fr-FR-Chirp3-HD-Charon" }, { ...request, fetchSpeech });
  assert.deepEqual(audio, Buffer.from(fakeAudio, "base64"));
  assert.equal(fetchSpeech.mock.callCount(), 1);
});

test("Read Aloud requests the agent's voice without context and keeps the WAV bytes and duration", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { PASEO_HOME: import.meta.dirname, GOOGLE_TTS_API_KEY: apiKey };
  const source = Buffer.from(pcmClip(new Float32Array(240).fill(0.5), 24_000).base64, "base64");
  // WAV chunks may include unknown metadata and padding between the format and samples.
  const audio = Buffer.concat([source.subarray(0, 36), Buffer.from("JUNK\u0001\u0000\u0000\u0000X\u0000"), source.subarray(36)]);
  audio.writeUInt32LE(audio.length - 8, 4);
  const base64 = audio.toString("base64");
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init.body)), {
      input: { text: "Hello" },
      voice: { languageCode: "en-US", name: pickAgentVoice(settings.google, "agent-0").id },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24_000, speakingRate: 1.1 },
    });
    return Response.json({ audioContent: base64 });
  });
  const file = await synthesize({ text: "Hello", agentId: "agent-0", previous: "Before", next: "After" }, settings);
  assert.deepEqual(file, { mimeType: "audio/wav", base64, durationMs: 10 });
  assert.deepEqual(await checkVoice(settings), { ok: true, voice: "Charon", provider: "google" });
});

test("long Google requests split at sentences and build one WAV with all the samples", async (t) => {
  const first = "The first passage is here. ".repeat(150);
  const second = "Another " + "short phrase ".repeat(150) + "ends here.";
  const chunks: string[] = [];
  let previousFinished = true;
  const fetchSpeech = t.mock.fn<typeof fetch>(async (_url, init) => {
    assert.ok(previousFinished, "Google requests must run sequentially");
    previousFinished = false;
    chunks.push(JSON.parse(String(init?.body)).input.text);
    await setImmediate();

    const clip = Buffer.from(pcmClip([chunks.length / 4], 24_000).base64, "base64");
    previousFinished = true;
    return Response.json({ audioContent: clip.toString("base64") });
  });
  const audio = await requestGoogle(googleVoice, { ...request, text: first + second, fetchSpeech });
  assert.deepEqual(chunks, [first, second]);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 5_000));
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.readUInt32LE(4), audio.length - 8);
  assert.equal(audio.readUInt32LE(24), 24_000);
  assert.equal(audio.toString("ascii", 36, 40), "data");
  assert.equal(audio.readUInt32LE(40), 4);
  assert.equal(audio.length, 48);
  assert.equal(audio.readInt16LE(44), 8192);
  assert.equal(audio.readInt16LE(46), 16384);
});

test("long MP3 requests split at whitespace or whole UTF-8 characters and join the bytes", async (t) => {
  for (const [first, second] of [
    ["word ".repeat(899), "untouched".repeat(200)],
    ["x".repeat(4499), "\u{1F600}".repeat(600)],
  ]) {
    const chunks: string[] = [];
    const fetchSpeech = t.mock.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.audioConfig.audioEncoding, "MP3");
      chunks.push(body.input.text);
      return Response.json({ audioContent: Buffer.of(chunks.length, 255).toString("base64") });
    });
    const audio = await requestGoogle(googleVoice, { text: first + second, format: "MP3", fetchSpeech });
    assert.deepEqual(chunks, [first, second]);
    assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 5_000));
    assert.deepEqual(audio, Buffer.of(1, 255, 2, 255));
  }
});

test("aborting a long request does not send its remaining Google chunks", async (t) => {
  const controller = new AbortController();
  const fetchSpeech = t.mock.fn<typeof fetch>(async () => {
    controller.abort();
    return Response.json({ audioContent: fakeAudio });
  });
  await assert.rejects(requestGoogle(googleVoice, {
    text: "Read this. ".repeat(600), format: "MP3", fetchSpeech, signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(fetchSpeech.mock.callCount(), 1);
});

test("Google errors explain common failures without leaking credentials", async (t) => {
  for (const [code, status, reason, message, bridgeStatus] of [
    [400, "INVALID_ARGUMENT", "API_KEY_INVALID", /Google rejected the API key/, 401],
    [403, "PERMISSION_DENIED", "SERVICE_DISABLED", /Turn on the Cloud Text-to-Speech API/, 502],
    [403, "PERMISSION_DENIED", "BILLING_DISABLED", /Turn on billing/, 502],
    [400, "INVALID_ARGUMENT", undefined, /check that the selected Chirp 3 HD voice/i, 400],
    [500, "INTERNAL", undefined, /failed \(500\)/, 502],
  ] as const) {
    const fetchSpeech = t.mock.fn<typeof fetch>(async () => googleFailure(code, status, reason));
    await assert.rejects(requestGoogle(googleVoice, { ...request, fetchSpeech }), (error) => {
      assert.ok(error instanceof GoogleSpeechError);
      assert.equal(error.status, bridgeStatus);
      assert.match(error.message, message);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
    assert.equal(fetchSpeech.mock.callCount(), 1);
  }
});

test("Google speech retries 429 and 503, then returns audio", async (t) => {
  const responses = [googleFailure(429, "RESOURCE_EXHAUSTED"), googleFailure(503, "UNAVAILABLE"),
    Response.json({ audioContent: fakeAudio })];
  const fetchSpeech = t.mock.fn<typeof fetch>(async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  assert.deepEqual(await requestGoogle(googleVoice, { ...request, fetchSpeech }), Buffer.from(fakeAudio, "base64"));
  assert.equal(fetchSpeech.mock.callCount(), 3);
});

test("Google speech returns a quota error after three retries", async (t) => {
  const fetchSpeech = t.mock.fn<typeof fetch>(async () => googleFailure(429, "RESOURCE_EXHAUSTED"));
  await assert.rejects(requestGoogle(googleVoice, { ...request, fetchSpeech }), {
    status: 429, message: "Google's text-to-speech quota is reached. Try again in a moment.",
  });
  assert.equal(fetchSpeech.mock.callCount(), 4);
});

test("stopping a session aborts active Google requests and any retry delay", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { PASEO_HOME: import.meta.dirname, GOOGLE_TTS_API_KEY: apiKey };
  const fetchSpeech = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const input = { text: "Hello", session: "google-cancel-test" };
  const speech = assert.rejects(synthesize(input, settings), /Read aloud was stopped/);
  await cancel({ session: input.session });
  await speech;
  await assert.rejects(synthesize(input, settings), /Read aloud was stopped/);
  assert.equal(fetchSpeech.mock.callCount(), 1);

  const retry = t.mock.fn<typeof fetch>(async () => googleFailure(429, "RESOURCE_EXHAUSTED"));
  const session = "google-cancel-retry-test";
  const waiting = assert.rejects(requestGoogle(googleVoice, { ...request, session, fetchSpeech: retry }), /Read aloud was stopped/);
  await setImmediate();
  await cancel({ session });
  await waiting;
  assert.equal(retry.mock.callCount(), 1);
});

test("keys are checked with voice lookup, saved privately, and overridden by the environment", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "google-tts-"));
  const env = process.env;
  t.after(() => { process.env = env; fs.rmSync(home, { recursive: true, force: true }); });
  process.env = { PASEO_HOME: home };
  assert.deepEqual(keyStatus(), { saved: false, source: "none" });
  assert.match((await checkVoice(settings)).problem ?? "", /No Google API key/);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://texttospeech.googleapis.com/v1/voices?languageCode=en-US");
    const key = new Headers(init.headers).get("X-Goog-Api-Key");
    return key === "good-key" ? Response.json({ voices: [] }) : googleFailure(400, "INVALID_ARGUMENT", "API_KEY_INVALID");
  });
  assert.deepEqual(await validateAndSaveKey({ apiKey }), { ok: false, error: "Google rejected the API key." });
  assert.deepEqual(keyStatus(), { saved: false, source: "none" });
  assert.deepEqual(await validateAndSaveKey({ apiKey: "good-key" }), { ok: true });
  const file = path.join(home, "plugin-data", "read-aloud", "google-key");
  assert.equal(fs.readFileSync(file, "utf8"), "good-key");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(keyStatus(), { saved: true, source: "file" });
  process.env.GOOGLE_TTS_API_KEY = "env-key";
  assert.deepEqual(keyStatus(), { saved: true, source: "env" });
  const resolved = resolveVoice({ settings });
  assert.equal(resolved.provider, "google");
  assert.equal(resolved.apiKey, "env-key");
  assert.deepEqual(removeKey(), { ok: true });
  assert.equal(fs.existsSync(file), false);
  delete process.env.GOOGLE_TTS_API_KEY;
  assert.deepEqual(keyStatus(), { saved: false, source: "none" });
});

test("voice lookup only returns US English Chirp 3 HD voices in name order", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { PASEO_HOME: import.meta.dirname, GOOGLE_TTS_API_KEY: apiKey };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://texttospeech.googleapis.com/v1/voices?languageCode=en-US");
    assert.equal(new Headers(init.headers).get("X-Goog-Api-Key"), apiKey);
    return Response.json({ voices: [
      { name: kore, languageCodes: ["en-US"], ssmlGender: "FEMALE", naturalSampleRateHertz: 24_000 },
      { name: "en-GB-Chirp3-HD-Kore", languageCodes: ["en-GB"], ssmlGender: "FEMALE", naturalSampleRateHertz: 24_000 },
      { name: "en-US-Standard-A", languageCodes: ["en-US"], ssmlGender: "MALE", naturalSampleRateHertz: 24_000 },
      { name: charon, languageCodes: ["en-US"], ssmlGender: "MALE", naturalSampleRateHertz: 24_000 },
    ] });
  });
  assert.deepEqual(await listVoices(), { voices: [
    { id: charon, name: "Charon (US English, male)" },
    { id: kore, name: "Kore (US English, female)" },
  ] });
});
