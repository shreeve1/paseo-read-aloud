import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { keyStatus, listVoices, removeKey, validateAndSaveKey } from "../server/elevenlabs.ts";
import { cancel, checkVoice, synthesize } from "../server/tts.ts";
import { pickAgentVoice, resolveVoice } from "../server/voices.ts";
import { voiceSettings } from "../shared/settings.ts";

const settings = voiceSettings.schema.parse({
  provider: "elevenlabs",
  elevenlabs: { voiceId: "main-id", voiceName: "Main", speed: 1.1, agentVoices: [{ id: "other-id", name: "Other" }] },
});

test("agent voice picks are stable and use the main voice without a pool or agent", () => {
  const pool = settings.elevenlabs;
  const picks = Array.from({ length: 10 }, (_, i) => pickAgentVoice(pool, `agent-${i}`));
  assert.deepEqual(new Set(picks.map(({ id }) => id)), new Set(["main-id", "other-id"]));
  for (const [i, pick] of picks.entries()) assert.deepEqual(pickAgentVoice(pool, `agent-${i}`), pick);
  assert.deepEqual(pickAgentVoice(pool), { id: "main-id", name: "Main" });
  assert.deepEqual(pickAgentVoice({ ...pool, agentVoices: [] }, "agent-1"), { id: "main-id", name: "Main" });
});

test("ElevenLabs plugin settings take priority and Paseo remains the default", () => {
  const env = { PASEO_VOICE_TTS_PROVIDER: "openai", ELEVENLABS_API_KEY: "fake-key" };
  assert.deepEqual(resolveVoice({ env, config: {}, settings }), {
    provider: "elevenlabs", apiKey: "fake-key", voiceId: "main-id", voiceName: "Main",
    model: "eleven_flash_v2_5", speed: 1.1,
  });
  assert.equal(resolveVoice({ env, config: {}, settings: voiceSettings.schema.parse({}) }).provider, "openai");
});

test("ElevenLabs sends PCM speech with context, retries once, and remembers which model rejected it", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { PASEO_HOME: import.meta.dirname, ELEVENLABS_API_KEY: "fake-key" };
  const bodies: unknown[] = [];
  const selected = pickAgentVoice(settings.elevenlabs, "agent-0");
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    assert.equal(url, `https://api.elevenlabs.io/v1/text-to-speech/${selected.id}?output_format=pcm_24000`);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("xi-api-key"), "fake-key");
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (bodies.length === 1) return Promise.resolve(new Response("next_text is not supported", { status: 422 }));
    return Promise.resolve(new Response(new Int16Array(240).fill(1000)));
  });
  const input = { text: "Hello", previous: "Before", next: "After", agentId: "agent-0" };
  const base = { text: "Hello", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.1 } };
  const clip = await synthesize(input, settings);
  assert.equal(clip.mimeType, "audio/wav");
  assert.equal(clip.durationMs, 10);
  await synthesize(input, settings);
  await synthesize(input, { ...settings, elevenlabs: { ...settings.elevenlabs, model: "eleven_multilingual_v2" } });
  await assert.rejects(() => synthesize({ ...input, localOnly: true }, settings), /Only local/);
  assert.deepEqual(bodies, [
    { ...base, previous_text: "Before", next_text: "After" }, base, base,
    { ...base, model_id: "eleven_multilingual_v2", previous_text: "Before", next_text: "After" },
  ]);
});

test("stopping a session aborts ElevenLabs speech and prevents later chunks", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { PASEO_HOME: import.meta.dirname, ELEVENLABS_API_KEY: "fake-key" };
  const fetch = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  );
  const input = { text: "Hello", session: "elevenlabs-cancel-test" };
  const speech = synthesize(input, settings);
  await cancel({ session: input.session });
  await assert.rejects(speech, /Read aloud was stopped/);
  await assert.rejects(() => synthesize(input, settings), /Read aloud was stopped/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("keys are validated, stored privately, and overridden by the environment", async (t) => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".elevenlabs-test-"));
  const env = process.env;
  t.after(() => { process.env = env; fs.rmSync(home, { recursive: true, force: true }); });
  process.env = { PASEO_HOME: home };
  assert.deepEqual(keyStatus(), { saved: false, source: "none" });
  assert.match((await checkVoice(settings)).problem ?? "", /No ElevenLabs API key/);
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.elevenlabs.io/v2/voices?page_size=1");
    const key = new Headers(init.headers).get("xi-api-key");
    return Promise.resolve(key === "good-key"
      ? Response.json({ voices: [] })
      : new Response(`Bad request. Key: ${key}`, { status: 400 }));
  });
  const invalid = await validateAndSaveKey({ apiKey: "bad-key" });
  assert.equal(invalid.ok, false);
  assert.doesNotMatch(invalid.error ?? "", /bad-key/);
  assert.equal(keyStatus().source, "none");
  assert.deepEqual(await validateAndSaveKey({ apiKey: "good-key" }), { ok: true });
  const dir = path.join(home, "plugin-data", "read-aloud");
  const file = path.join(dir, "elevenlabs-key");
  assert.equal(fs.readFileSync(file, "utf8"), "good-key");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(keyStatus(), { saved: true, source: "file" });
  assert.match((await checkVoice(voiceSettings.schema.parse({ provider: "elevenlabs" }))).problem ?? "", /No ElevenLabs voice/);
  process.env.ELEVENLABS_API_KEY = "env-key";
  assert.deepEqual(keyStatus(), { saved: true, source: "env" });
  const resolved = resolveVoice({ settings });
  assert.ok(resolved.provider === "elevenlabs");
  assert.equal(resolved.apiKey, "env-key");
  assert.deepEqual(removeKey(), { ok: true });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(keyStatus(), { saved: true, source: "env" });
});

test("voice lookup passes search and pagination through and stops at five pages", async (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { PASEO_HOME: import.meta.dirname, ELEVENLABS_API_KEY: "fake-key" };
  let page = 0;
  t.mock.method(globalThis, "fetch", (url: string) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get("page_size"), "100");
    assert.equal(query.get("search"), "test voice");
    assert.equal(query.get("next_page_token"), page ? String(page) : null);
    return Promise.resolve(Response.json({
      voices: [{ voice_id: String(page), name: `Voice ${5 - page}`, category: "cloned" }],
      has_more: true, next_page_token: String(++page),
    }));
  });
  const { voices } = await listVoices({ search: "test voice" });
  assert.equal(page, 5);
  assert.deepEqual(voices.map(({ name }) => name), ["Voice 1", "Voice 2", "Voice 3", "Voice 4", "Voice 5"]);
});
