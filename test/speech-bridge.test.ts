import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { bridgePort, startSpeechBridge } from "../server/speech-bridge.ts";
import { voiceSettings } from "../shared/settings.ts";

const settings = voiceSettings.schema.parse({
  provider: "elevenlabs",
  elevenlabs: { voiceId: "main/voice", speed: 1.1, agentVoices: [{ id: "other", name: "Other" }] },
}).elevenlabs;
const env = { PASEO_HOME: import.meta.dirname, ELEVENLABS_API_KEY: "fake-key", OPENAI_TTS_API_KEY: "test-tts-key" };
const authorization = { Authorization: `Bearer ${env.OPENAI_TTS_API_KEY}` };
const bytes = Uint8Array.of(0, 0, 7, 123, 255, 253);
const errorBody = z.object({ error: z.object({ message: z.string(), type: z.string() }) });

async function openBridge(t: TestContext, options: Partial<Parameters<typeof startSpeechBridge>[0]> = {}) {
  const upstream = t.mock.fn<typeof fetch>(async () => new Response(bytes));
  const bridge = startSpeechBridge({
    getSettings: async () => settings, port: 0, env, fetchSpeech: upstream, ...options,
  });
  t.after(() => bridge.close());
  for (let tries = 0; !bridge.status().listening && tries < 100; tries++) await setTimeout(5);
  const url = bridge.url();
  const { origin: base, port: portString } = new URL(url);
  const port = Number(portString);
  assert.ok(port, bridge.status().error ?? "The speech bridge did not bind");
  const speak = (body: object) => fetch(url + "/audio/speech", {
    method: "POST", headers: { "Content-Type": "application/json", ...authorization },
    body: JSON.stringify(body),
  });
  return { base, bridge, port, speak, upstream };
}

test("bridge ports use a valid override or derive a port from the Linux user ID", () => {
  assert.equal(bridgePort({ READ_ALOUD_BRIDGE_PORT: "1024" }, 123), 1024);
  assert.equal(bridgePort({ READ_ALOUD_BRIDGE_PORT: "65535" }, 123), 65535);
  for (const invalid of ["", "0", "1023", "65536", "25000.5", "2e4", "bad"]) {
    assert.equal(bridgePort({ READ_ALOUD_BRIDGE_PORT: invalid }, 123), 20123);
  }
  assert.equal(bridgePort({}, 0), 20000);
  assert.equal(bridgePort({}, 10124), 20124);
  assert.equal(bridgePort({}), 20000 + ((process.getuid?.() ?? 0) % 10000));
});

test("the bridge rejects missing and wrong bearer tokens before parsing the body", async (t) => {
  const { bridge, upstream } = await openBridge(t);
  for (const headers of [undefined, { Authorization: "Bearer bad--tts-key" }]) {
    const response = await fetch(bridge.url() + "/audio/speech", {
      method: "POST", headers, body: "{bad json",
    });
    assert.equal(response.status, 401);
    const { error } = errorBody.parse(await response.json());
    assert.equal(error.type, "authentication_error");
    assert.doesNotMatch(error.message, /test-tts-key|bad--tts-key/);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("the bridge reads the configured key on each request and falls back to the daemon environment", async (t) => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".bridge-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const testEnv: NodeJS.ProcessEnv = { ...env, PASEO_HOME: home, OPENAI_API_KEY: "test-openai-key" };
  const { bridge, upstream } = await openBridge(t, { env: testEnv });
  const configFile = path.join(home, "config.json");
  const writeKey = (apiKey: string) => fs.writeFileSync(configFile, JSON.stringify({
    features: { voiceMode: { tts: { provider: "openai", apiKey } } },
  }), { mode: 0o600 });
  const speak = async (key: string) => {
    const response = await fetch(bridge.url() + "/audio/speech", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: '{"input":"Hello"}',
    });
    await response.arrayBuffer();
    return response.status;
  };
  writeKey("configured-key");
  assert.equal(await speak("configured-key"), 200);
  assert.equal(await speak(env.OPENAI_TTS_API_KEY), 401);
  writeKey("rotated-key");
  assert.equal(await speak("configured-key"), 401);
  assert.equal(await speak("rotated-key"), 200);

  fs.unlinkSync(configFile);
  assert.equal(await speak("test-openai-key"), 401);
  assert.equal(await speak(env.OPENAI_TTS_API_KEY), 200);
  delete testEnv.OPENAI_TTS_API_KEY;
  assert.equal(await speak("test-openai-key"), 200);
  assert.equal(upstream.mock.callCount(), 4);
});

test("the bridge prompts to reconnect when no private key is configured", async (t) => {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".bridge-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { bridge, upstream } = await openBridge(t, {
    env: { PASEO_HOME: home, ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY },
  });
  for (const key of [undefined, "read-aloud-bridge"]) {
    if (key) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      features: { voiceMode: { tts: { provider: "openai", apiKey: key } } },
    }), { mode: 0o600 });
    const response = await fetch(bridge.url() + "/audio/speech", {
      method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {}, body: '{"input":"Hello"}',
    });
    assert.equal(response.status, 401);
    const { error } = errorBody.parse(await response.json());
    assert.equal(error.type, "authentication_error");
    assert.match(error.message, /turn the Voice mode switch off and on again/i);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("the bridge sends the main voice and returns the requested audio bytes unchanged", async (t) => {
  const { speak, upstream } = await openBridge(t);
  for (const [format, upstreamFormat, contentType] of [
    ["pcm", "pcm_24000", "audio/pcm"],
    ["mp3", "mp3_44100_128", "audio/mpeg"],
    [undefined, "mp3_44100_128", "audio/mpeg"],
    ["wav", "wav_24000", "audio/wav"],
  ]) {
    const response = await speak({ input: "Hello", response_format: format, voice: "ignored", model: "ignored" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), contentType);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const call = upstream.mock.calls.at(-1);
    assert.ok(call);
    const [url, init] = call.arguments;
    assert.equal(url, `https://api.elevenlabs.io/v1/text-to-speech/main%2Fvoice?output_format=${upstreamFormat}`);
    assert.equal(new Headers(init?.headers).get("xi-api-key"), env.ELEVENLABS_API_KEY);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text, "Hello");
    assert.equal(body.model_id, settings.model);
    assert.deepEqual(body.voice_settings, { speed: 1.1 });
  }
});

test("continuity uses only the previous request and expires at 20 seconds", async (t) => {
  let time = 1;
  const { speak, upstream } = await openBridge(t, { now: () => time });
  for (const [input, delay] of [["First", 0], ["Second", 19_999], ["Third", 20_000], ["Fourth", 1]] as const) {
    time += delay;
    const response = await speak({ input });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const bodies = upstream.mock.calls.map(({ arguments: [, init] }) => JSON.parse(String(init?.body)));
  assert.deepEqual(bodies.map((body) => body.previous_text), [undefined, "First", undefined, "Third"]);
});

test("invalid routes, methods, JSON, formats and oversized requests do not call ElevenLabs", async (t) => {
  const { base, speak, upstream } = await openBridge(t);
  const url = base + "/v1/audio/speech";
  const responses = [
    [404, await fetch(base + "/missing", { method: "POST" })],
    [405, await fetch(url)],
    [400, await fetch(url, { method: "POST", headers: authorization, body: "{bad json" })],
    [400, await speak({ input: "Hello", response_format: "opus" })],
    [400, await speak({ input: " " })],
    [400, await speak({ input: "\u00e9".repeat(32 * 1024) })],
    [403, await fetch(url, { method: "POST", headers: { ...authorization, Origin: "https://example.test" }, body: '{"input":"hello"}' })],
  ] as const;
  for (const [status, response] of responses) {
    assert.equal(response.status, status);
    const { error } = errorBody.parse(await response.json());
    assert.equal(error.type, "invalid_request_error");
    assert.ok(error.message);
  }
  assert.equal(responses[1][1].headers.get("allow"), "POST");
  assert.equal(upstream.mock.callCount(), 0);
});

test("bridge errors name missing settings and never expose the upstream key", async (t) => {
  let status = 401;
  const testEnv: NodeJS.ProcessEnv = { ...env };
  let voiceId = settings.voiceId;
  const { speak } = await openBridge(t, {
    env: testEnv, getSettings: async () => ({ ...settings, voiceId }),
    fetchSpeech: async () => new Response("Upstream error: fake-key", { status }),
  });
  for (const [upstream, expected, type] of [
    [401, 401, "authentication_error"], [429, 429, "rate_limit_error"], [422, 502, "server_error"],
  ] as const) {
    status = upstream;
    const response = await speak({ input: "Hello" });
    assert.equal(response.status, expected);
    const { error } = errorBody.parse(await response.json());
    assert.equal(error.type, type);
    assert.doesNotMatch(error.message, /fake-key/);
  }
  voiceId = "";
  for (const setting of [/Choose an ElevenLabs voice/, /No ElevenLabs API key/]) {
    const response = await speak({ input: "Hello" });
    assert.equal(response.status, 400);
    const { error } = errorBody.parse(await response.json());
    assert.match(error.message, setting);
    assert.match(error.message, /Settings.*Read Aloud/);
    delete testEnv.ELEVENLABS_API_KEY;
  }
});

test("a port conflict is reported once and cleanup releases the listening port", async (t) => {
  const { bridge, port } = await openBridge(t);
  const warn = t.mock.method(console, "warn", () => {});
  const second = startSpeechBridge({ port, getSettings: async () => settings, env });
  t.after(() => second.close());
  for (let tries = 0; !second.status().error && tries < 100; tries++) await setTimeout(5);
  assert.equal(second.status().listening, false);
  assert.match(second.status().error ?? "", /EADDRINUSE/);
  assert.equal(warn.mock.callCount(), 1);
  await bridge.close();
  assert.equal(bridge.status().listening, false);
  await openBridge(t, { port });
});
