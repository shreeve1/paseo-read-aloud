import assert from "node:assert/strict";
import { Server } from "node:net";
import { dirname } from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPlayer } from "../client/player";
import { registerReadAloud } from "../index.server";
import type { Mode } from "../server/managed";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import { managedStatus, managedVoices } from "../shared/managed";
import { voiceSettings, type VoiceSettings } from "../shared/settings";
import { cancelSpeech, synthesizeSpeech, voiceStatus, type SpeechFile } from "../shared/speech";
import { mockHub } from "./managed-fixture";

const text = protocol.pilot.fixture_text;

function plugin(t: TestContext, mode: Mode, provider: VoiceSettings["provider"]) {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  let state = { status: "ready", revision: "1", values: voiceSettings.schema.parse({
    provider, managed: { voiceId: "one", voiceName: "First" }, elevenlabs: { voiceId: "old" },
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
    handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => handlers.set(contract.name, handler),
    addHook: () => () => {},
  };
  t.after(registerReadAloud(context as unknown as PluginServerContext, mode));

  return {
    handlers,
    async call(name: string, input: object = {}) {
      const handler = handlers.get(name);
      assert.ok(handler, `Missing RPC ${name}`);
      return handler(input);
    },
    changeProvider(provider: VoiceSettings["provider"]) {
      state = { ...state, values: { ...state.values, provider } };
      listener(state);
    },
  };
}

test("the managed handler table exposes neither direct ElevenLabs nor the Voice mode bridge", async (t) => {
  const { mode, requests } = await mockHub(t, () => assert.fail("Unexpected request"));
  const listening = t.mock.method(Server.prototype, "listen");
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));

  for (const hostMode of [mode, { kind: "managed-unavailable", reason: "Check the host certificate." }] as const) {
    const server = plugin(t, hostMode, "elevenlabs");
    assert.deepEqual([...server.handlers.keys()].sort(), [
      "managed.status", "managed.voices", "speech.cancel", "speech.status", "speech.synthesize",
    ]);
    const status = managedStatus.output.parse(await server.call(managedStatus.name));
    assert.equal(status.mode, hostMode.kind);
    assert.match(voiceStatus.output.parse(await server.call(voiceStatus.name)).problem ?? "", /Direct ElevenLabs/);
    await assert.rejects(server.call(synthesizeSpeech.name, { text }), /Choose Central voice.*local playback/);
    if (hostMode.kind === "managed-unavailable") {
      await assert.rejects(server.call(managedVoices.name), /Check the host certificate/);
      server.changeProvider("managed");
      await assert.rejects(server.call(synthesizeSpeech.name, { text }), /Check the host certificate/);
    }
  }
  assert.equal(listening.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(requests, []);
});

test("managed synthesis is on demand and cannot use Paseo's cloud speaking settings", async (t) => {
  const { mode, requests, files } = await mockHub(t, () => assert.fail("Unexpected request"));
  const server = plugin(t, mode, "managed");
  await assert.rejects(server.call(synthesizeSpeech.name, { text, automatic: true }), /Automatic reading is off/);
  await assert.rejects(server.call(synthesizeSpeech.name, { text, localOnly: true }), /Press the speaker button/);
  server.changeProvider("paseo");
  const env = process.env;
  const overrides = { PASEO_HOME: dirname(files.config), PASEO_VOICE_TTS_PROVIDER: "openai" };
  for (const [name, value] of Object.entries(overrides)) {
    const previous = env[name];
    env[name] = value;
    t.after(() => {
      if (previous === undefined) delete env[name];
      else env[name] = previous;
    });
  }
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected fetch"));
  assert.match(voiceStatus.output.parse(await server.call(voiceStatus.name)).problem ?? "", /Speaking to Local/);
  await assert.rejects(server.call(synthesizeSpeech.name, { text }), /Only local voices/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(requests, []);
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
      return synthesizeSpeech.output.parse(await server.call(synthesizeSpeech.name, {
        ...input, previous: "omitted context", next: "also omitted",
      }));
    },
    cancel: (session) => server.call(cancelSpeech.name, { session }),
    async playAudio(audio) { played.push(audio); },
  });
  await player.play("fixture", text, (error) => assert.fail(String(error)), undefined, false);
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
  assert.deepEqual(await server.call(managedVoices.name), { voices: [] });
  await assert.rejects(server.call(synthesizeSpeech.name, { text }), /That voice is no longer available.*local playback/);
  assert.equal(fetch.mock.callCount(), 0);
});
