import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createVoicePreview } from "../client/voice-preview";
import { createPlayer } from "../client/player";
import { registerReadAloud } from "../index.server";
import type { Mode } from "../server/managed";
import { bridgePort } from "../server/speech-bridge";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import { managedStatus, managedVoices } from "../shared/managed";
import { voiceSettings, type ManagedSpeed, type VoiceSettings } from "../shared/settings";
import { cancelSpeech, synthesizeSpeech, voiceStatus, type SpeechFile } from "../shared/speech";
import { voiceModeStatus } from "../shared/voice-mode";
import { mockHub } from "./managed-fixture";

const text = protocol.pilot.fixture_text;

function plugin(t: TestContext, mode: Mode, provider: VoiceSettings["provider"], config: unknown = speakingConfig({ provider: "local" })) {
  type Handler = (input: unknown, context: { paseo: { config: unknown } }) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  let state = { status: "ready", revision: "1", values: voiceSettings.schema.parse({
    provider, managed: { voiceId: "one", voiceName: "First" }, google: {},
  }) };
  let listener: (value: typeof state) => void;
  const context = {
    registerSettings: () => ({
      read: async () => state,
      subscribe: (onChange: typeof listener) => {
        listener = onChange;
        return () => {};
      },
    }),
    handle: (contract: { name: string }, handler: Handler) => handlers.set(contract.name, handler),
    addHook: () => () => {},
  };
  t.after(registerReadAloud(context as unknown as PluginServerContext, mode));

  return {
    handlers,
    async call(name: string, input: object = {}) {
      const handler = handlers.get(name);
      assert.ok(handler, `Missing RPC ${name}`);
      return handler(name === synthesizeSpeech.name ? synthesizeSpeech.input.parse(input) : input, { paseo: { config } });
    },
    changeProvider(provider: VoiceSettings["provider"]) {
      state = { ...state, values: { ...state.values, provider } };
      listener(state);
    },
    changeSpeed(speed: ManagedSpeed) {
      state = { ...state, values: { ...state.values, managed: { ...state.values.managed, speed } } };
      listener(state);
    },
  };
}

test("personal registration starts the bridge and exposes Voice mode and Google controls", async (t) => {
  const listen = Server.prototype.listen;
  const listening = t.mock.method(Server.prototype, "listen", function (this: Server, options: object) {
    return Reflect.apply(listen, this, [{ ...options, port: 0 }]);
  });
  const config = speakingConfig({ provider: "local" });
  const server = plugin(t, { kind: "personal" }, "paseo", config);
  assert.deepEqual([...server.handlers.keys()].sort(), [
    "google.clear-key", "google.key-status", "google.save-key", "google.voices",
    "managed.status", "speech.cancel", "speech.status", "speech.synthesize", "voice-mode.connect", "voice-mode.status",
  ]);
  const bridge = listening.mock.calls[0]?.this;
  assert.ok(bridge instanceof Server);
  if (!bridge.listening) await once(bridge, "listening");
  assert.equal(voiceModeStatus.output.parse(await server.call(voiceModeStatus.name)).listening, true);
});

type Speaking = { provider: string; baseUrl?: string | null };
function speakingConfig(initial: Speaking, restore = true) {
  let tts = initial;
  return {
    async get() { return { config: { features: { voiceMode: { tts } } } }; },
    async patch(patch: { features: { voiceMode: { tts: Speaking } } }) {
      if (restore) tts = patch.features.voiceMode.tts;
      return this.get();
    },
  };
}

test("managed status restores a previously bridged Speaking provider without starting a bridge", async (t) => {
  const { mode, files } = await mockHub(t, () => assert.fail("Unexpected request"));
  const home = dirname(files.config);
  overrideEnv(t, "PASEO_HOME", home);
  const record = join(home, "plugin-data", "read-aloud", "voice-mode.json");
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ provider: "local" }));
  const config = speakingConfig({ provider: "openai", baseUrl: `http://127.0.0.1:${bridgePort()}/v1` });
  const listening = t.mock.method(Server.prototype, "listen");
  const server = plugin(t, mode, "managed", config);
  await Promise.all([server.call(managedStatus.name), server.call(voiceStatus.name)]);
  assert.deepEqual((await config.get()).config.features.voiceMode.tts, { provider: "local" });
  assert.equal(existsSync(record), false);
  assert.equal(listening.mock.callCount(), 0);
});

test("an unconfirmed Speaking restore is reported in both status responses", async (t) => {
  const { mode, files } = await mockHub(t, () => assert.fail("Unexpected request"));
  overrideEnv(t, "PASEO_HOME", dirname(files.config));
  const config = speakingConfig({ provider: "openai", baseUrl: `http://127.0.0.1:${bridgePort()}/v1` }, false);
  const server = plugin(t, mode, "managed", config);
  const voice = voiceStatus.output.parse(await server.call(voiceStatus.name));
  const managed = managedStatus.output.parse(await server.call(managedStatus.name));
  assert.notEqual(managed.mode, "personal");
  assert.ok("speakingProblem" in managed);
  assert.match(voice.speakingProblem ?? "", /did not restore Speaking/);
  assert.equal(managed.speakingProblem, voice.speakingProblem);
});

function overrideEnv(t: TestContext, key: string, value: string) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("the managed handler table exposes neither direct Google nor the Voice mode bridge", async (t) => {
  const { mode, requests } = await mockHub(t, () => assert.fail("Unexpected request"));
  const listening = t.mock.method(Server.prototype, "listen");
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));

  for (const hostMode of [mode, { kind: "managed-unavailable", reason: "Check the host certificate." }] as const) {
    const server = plugin(t, hostMode, "google");
    assert.deepEqual([...server.handlers.keys()].sort(), [
      "managed.status", "managed.voices", "speech.cancel", "speech.status", "speech.synthesize",
    ]);
    const status = managedStatus.output.parse(await server.call(managedStatus.name));
    assert.equal(status.mode, hostMode.kind);
    assert.match(voiceStatus.output.parse(await server.call(voiceStatus.name)).problem ?? "", /Direct Google/);
    await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true }), /Choose Central voice.*local playback/);
    if (hostMode.kind === "managed-unavailable") {
      await assert.rejects(server.call(managedVoices.name), /Check the host certificate/);
      server.changeProvider("managed");
      await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true }), /Check the host certificate/);
    }
  }
  assert.equal(listening.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(requests, []);
});

test("managed synthesis is on demand and cannot use Paseo's cloud speaking settings", async (t) => {
  const { mode, requests, files } = await mockHub(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Audio-Format": "pcm_s16le_24000_mono" })
      .end(Buffer.from([0, 0]));
  });
  const server = plugin(t, mode, "managed");
  await assert.rejects(server.call(synthesizeSpeech.name, { text }), /Press the speaker button/);
  await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true, automatic: true }), /Automatic reading is off/);
  await assert.rejects(server.call(synthesizeSpeech.name, { text, localOnly: true }), /Press the speaker button/);
  server.changeProvider("paseo");
  overrideEnv(t, "PASEO_HOME", dirname(files.config));
  overrideEnv(t, "PASEO_VOICE_TTS_PROVIDER", "openai");
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));
  assert.match(voiceStatus.output.parse(await server.call(voiceStatus.name)).problem ?? "", /Speaking to Local/);
  await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true }), /Only local voices/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(requests, []);
});

test("pressing a non-fixture reply sends no HTTP request, even if it includes the fixture line", async (t) => {
  const { mode, requests } = await mockHub(t, (_request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" })
      .end('{"error":{"code":"text_not_allowed","message":"Fixture only"}}');
  });
  const server = plugin(t, mode, "managed");
  const errors: unknown[] = [];
  const player = createPlayer({
    async speak(input) {
      return synthesizeSpeech.output.parse(await server.call(synthesizeSpeech.name, input));
    },
    async cancel() {},
    async playAudio() { assert.fail("Non-fixture audio played"); },
  });
  const replies = ["Another synthetic reply.", text + " Extra text follows.", text + "\n?"];
  for (const [index, reply] of replies.entries()) {
    await player.play(String(index), reply, (error) => errors.push(error), undefined, false);
  }
  assert.deepEqual(requests, []);
  assert.equal(errors.length, replies.length);
  for (const error of errors) assert.match(String(error), /The pilot only reads.*blue notebook/);
});

test("approved voices and realistic hub PCM reach the Paseo RPC as playable WAV; revoked voices fail", async (t) => {
  const pcm = Buffer.alloc(24_000 * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const t = i / 24_000;
    const phase = 2 * Math.PI * (145 * t + 37 * t * t);
    const envelope = 0.4 + 0.5 * Math.sin(2 * Math.PI * 1.7 * t) ** 2;
    pcm.writeInt16LE(Math.round(7000 * envelope * (Math.sin(phase) + 0.3 * Math.sin(3 * phase))), i * 2);
  }
  let allowed = true;
  const { mode, requests } = await mockHub(t, (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ voices: allowed ? [{ id: "one", name: "First" }] : [] }));
    } else if (allowed) {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Audio-Format": "pcm_s16le_24000_mono" })
        .end(pcm);
    } else {
      response.writeHead(403, { "Content-Type": "application/json" })
        .end('{"error":{"code":"voice_not_allowed","message":"Removed"}}');
    }
  });
  const server = plugin(t, mode, "managed");
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));
  assert.deepEqual(await server.call(managedVoices.name), { voices: [{ id: "one", name: "First" }] });

  const played: SpeechFile[] = [];
  const player = createPlayer({
    async speak(input) {
      return synthesizeSpeech.output.parse(await server.call(synthesizeSpeech.name, input));
    },
    cancel: (session) => server.call(cancelSpeech.name, { session }),
    async playAudio(audio) { played.push(audio); },
  });
  await player.play("fixture", `**${text}**`, (error) => assert.fail(String(error)), undefined, false);
  assert.equal(played.length, 1);
  const [speech] = played;
  assert.equal(speech.mimeType, "audio/wav");
  const wav = Buffer.from(speech.base64, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.equal(speech.durationMs, 1_000);
  assert.deepEqual(JSON.parse(requests[1].body), { voice_id: "one", text });

  allowed = false;
  await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true }), /That voice is no longer available.*local playback/);
  const status = voiceStatus.output.parse(await server.call(voiceStatus.name));
  assert.equal(status.ok, false);
  assert.equal(status.unavailableVoiceId, "one");
  assert.match(status.problem ?? "", /That voice is no longer available/);
  const beforeRetry = requests.length;
  await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true }), /That voice is no longer available/);
  assert.equal(requests.length, beforeRetry);
  assert.deepEqual(await server.call(managedVoices.name), { voices: [] });
  assert.equal(fetch.mock.callCount(), 0);
});

test("Settings preview and the chat speaker use the saved speed and preserve pitch", {
  skip: spawnSync("ffmpeg", ["-version"]).status === 0 ? false : "FFmpeg is not installed",
}, async (t) => {
  const pcm = Buffer.alloc(24_000 * 2);
  for (let i = 0; i < 24_000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 24_000)), i * 2);
  const { mode, requests } = await mockHub(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Audio-Format": "pcm_s16le_24000_mono" })
      .end(pcm);
  });
  const server = plugin(t, mode, "managed");
  const speak = async (input: object) => synthesizeSpeech.output.parse(await server.call(synthesizeSpeech.name, input));
  const played: SpeechFile[] = [];
  const playAudio = async (audio: SpeechFile) => { played.push(audio); };
  const preview = createVoicePreview();
  const player = createPlayer({
    speak, playAudio,
    cancel: (session) => server.call(cancelSpeech.name, { session }),
  });
  server.changeSpeed(1.5);
  await preview.play({ mode: "managed", speak, playAudio });
  await player.play("fixture", text, (error) => assert.fail(String(error)), undefined, false);
  server.changeSpeed(0.5);
  await preview.play({ mode: "managed", speak, playAudio });

  assert.equal(played.length, 3);
  assert.deepEqual(played[0], played[1]);
  for (const [clip, expectedDuration] of [[played[0], 1000 / 1.5], [played[2], 2000]] as const) {
    assert.equal(clip.mimeType, "audio/wav");
    assert.ok(clip.durationMs && Math.abs(clip.durationMs - expectedDuration) < 60);
    const wav = Buffer.from(clip.base64, "base64");
    let cycles = 0;
    for (let offset = 46; offset < wav.length; offset += 2) {
      if (wav.readInt16LE(offset - 2) <= 0 && wav.readInt16LE(offset) > 0) cycles++;
    }
    assert.ok(Math.abs(cycles / (clip.durationMs / 1000) - 440) < 5);
  }
  assert.deepEqual(requests.map(({ body }) => JSON.parse(body)), Array(3).fill({ voice_id: "one", text }));
});

test("a missing FFmpeg blocks non-1x speech before calling the hub and still allows 1x", async (t) => {
  const { mode, requests } = await mockHub(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Audio-Format": "pcm_s16le_24000_mono" })
      .end(Buffer.from([0, 0]));
  });
  overrideEnv(t, "PATH", "");
  const server = plugin(t, mode, "managed");
  const status = managedStatus.output.parse(await server.call(managedStatus.name));
  assert.equal(status.mode, "managed");
  assert.match(status.speedProblem ?? "", /FFmpeg.*Choose 1x/);
  server.changeSpeed(2);
  await assert.rejects(server.call(synthesizeSpeech.name, { text, manual: true }), /FFmpeg.*Choose 1x/);
  assert.deepEqual(requests, []);
  server.changeSpeed(1);
  assert.equal(synthesizeSpeech.output.parse(await server.call(synthesizeSpeech.name, { text, manual: true })).mimeType, "audio/wav");
  assert.equal(requests.length, 1);
});
