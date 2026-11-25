import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { startSpeechBridge } from "../server/speech-bridge.ts";
import { voiceSettings } from "../shared/settings.ts";

const settings = voiceSettings.schema.parse({
  provider: "elevenlabs",
  elevenlabs: { voiceId: "main/voice", speed: 1.1, agentVoices: [{ id: "other", name: "Other" }] },
}).elevenlabs;
const env = { PASEO_HOME: import.meta.dirname, ELEVENLABS_API_KEY: "fake-key" };
const bytes = Uint8Array.of(0, 0, 7, 123, 255, 253);
const errorBody = z.object({ error: z.object({ message: z.string(), type: z.string() }) });

async function openBridge(t: TestContext, options: Partial<Parameters<typeof startSpeechBridge>[0]> = {}) {
  const upstream = t.mock.fn<typeof fetch>(async () => new Response(bytes));
  const bridge = startSpeechBridge({
    getSettings: async () => settings, port: 0, env, fetchSpeech: upstream, ...options,
  });
  t.after(() => bridge.close());
  for (let tries = 0; !bridge.status().listening && tries < 100; tries++) await setTimeout(5);
  const port = bridge.port();
  assert.ok(port, bridge.status().error ?? "The speech bridge did not bind");
  const base = `http://127.0.0.1:${port}`;
  const speak = (body: object) => fetch(base + "/v1/audio/speech", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer ignored" },
    body: JSON.stringify(body),
  });
  return { base, bridge, port, speak, upstream };
}

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
    [400, await fetch(url, { method: "POST", body: "{bad json" })],
    [400, await speak({ input: "Hello", response_format: "opus" })],
    [400, await speak({ input: " " })],
    [400, await speak({ input: "\u00e9".repeat(32 * 1024) })],
    [403, await fetch(url, { method: "POST", headers: { Origin: "https://example.test" }, body: '{"input":"hello"}' })],
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
