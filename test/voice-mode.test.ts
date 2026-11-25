import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createVoiceModeControls } from "../server/voice-mode.ts";

type ConfigAccess = Parameters<ReturnType<typeof createVoiceModeControls>["status"]>[0];
type Config = Awaited<ReturnType<ConfigAccess["get"]>>["config"];
type Patch = Parameters<ConfigAccess["patch"]>[0];
type VoiceMode = NonNullable<Config["features"]>["voiceMode"];
type Tts = VoiceMode["tts"];

const local = { provider: "local" } as const;
const openai = { provider: "openai", hasApiKey: true, model: "tts-1-hd", voice: "onyx" } as const;
const bridgeUrl = "http://127.0.0.1:23571/v1";
const bridged = { ...openai, baseUrl: bridgeUrl };
const bridge = { status: () => ({ listening: true, error: undefined }), url: () => bridgeUrl };
const stoppedBridge = { ...bridge, status: () => ({ listening: false, error: "Port in use" }) };

function fakeConfig(initial: Tts, ...results: Tts[]) {
  const patches: Patch[] = [];
  const payload = (tts: Tts): Awaited<ReturnType<ConfigAccess["get"]>> => ({
    requestId: "test",
    config: {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      features: {
        dictation: { enabled: true, stt: local },
        voiceMode: { enabled: true, stt: local, tts },
      },
    },
  });
  let current = initial;
  const config: ConfigAccess = {
    async get() { return payload(current); },
    async patch(patch) {
      patches.push(patch);
      const next = results.shift();
      assert.ok(next, "unexpected config patch");
      current = next;
      return payload(current);
    },
  };
  return { config, patches };
}

function setup(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".voice-mode-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const record = path.join(home, "plugin-data", "read-aloud", "voice-mode.json");
  const controls = createVoiceModeControls({ bridge, home, env });
  return { controls, home, record };
}

function writeOpenAiKey(home: string, apiKey: string) {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    features: { voiceMode: { tts: { provider: "openai", apiKey } } },
  }), { mode: 0o600 });
}

function assertBridgeToken(patch: Patch) {
  const tts = patch.features?.voiceMode?.tts;
  assert.equal(tts?.provider, "openai");
  assert.equal(tts.baseUrl, bridgeUrl);
  assert.ok(typeof tts.apiKey === "string", "Expected a bridge token in the config patch");
  assert.ok(/^[\w-]{43}$/.test(tts.apiKey), "Expected a 32-byte base64url bridge token");
  return tts.apiKey;
}

test("connecting an OpenAI setup patches only the Base URL and disabling clears it", async (t) => {
  const { controls, home, record } = setup(t);
  writeOpenAiKey(home, "existing-openai-key");
  const { config, patches } = fakeConfig(openai, bridged, openai);
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.deepEqual(await controls.status(config), { listening: true, error: undefined, connected: true, provider: "openai" });
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.deepEqual(await controls.connect(config, false), { ok: true });
  assert.equal((await controls.status(config)).connected, false);
  assert.deepEqual(patches, [
    { features: { voiceMode: { tts: { provider: "openai", baseUrl: bridgeUrl } } } },
    { features: { voiceMode: { tts: { baseUrl: null } } } },
  ]);
});

test("connecting Local saves the provider and disabling restores it even after a plugin restart", async (t) => {
  const { controls, home, record } = setup(t);
  const { config, patches } = fakeConfig(local, bridged, local);
  assert.equal((await controls.status(config)).provider, "local");
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), { provider: "local" });
  const restarted = createVoiceModeControls({ bridge: stoppedBridge, home, env: {} });
  assert.deepEqual(await restarted.status(config), { listening: false, error: "Port in use", connected: true, provider: "openai" });
  assert.deepEqual(await restarted.connect(config, false), { ok: true });
  assert.equal(fs.existsSync(record), false);
  const firstToken = assertBridgeToken(patches[0]);
  assert.deepEqual(patches[1], { features: { voiceMode: { tts: { provider: "local" } } } });
  const next = fakeConfig(local, bridged);
  assert.deepEqual(await controls.connect(next.config, true), { ok: true });
  assert.ok(assertBridgeToken(next.patches[0]) !== firstToken, "Expected a fresh bridge token");
});

test("connecting OpenAI keeps an environment key or creates a token when no key is available", async (t) => {
  const withoutKey = { ...openai, hasApiKey: false };
  const withEnv = setup(t, { OPENAI_API_KEY: "environment-openai-key" });
  const existing = fakeConfig(withoutKey, bridged);
  assert.deepEqual(await withEnv.controls.connect(existing.config, true), { ok: true });
  assert.deepEqual(existing.patches, [
    { features: { voiceMode: { tts: { provider: "openai", baseUrl: bridgeUrl } } } },
  ]);

  const { controls } = setup(t);
  const missing = fakeConfig(withoutKey, bridged);
  assert.deepEqual(await controls.connect(missing.config, true), { ok: true });
  assertBridgeToken(missing.patches[0]);
});

test("reconnecting replaces the old public key and retains the Local restore point", async (t) => {
  const { controls, home, record } = setup(t);
  writeOpenAiKey(home, "read-aloud-bridge");
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ provider: "local" }));
  const { config, patches } = fakeConfig({ ...openai, baseUrl: "http://127.0.0.1:8390/v1" }, bridged, local);
  assert.equal((await controls.status(config)).connected, false);
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assertBridgeToken(patches[0]);
  assert.deepEqual(await controls.connect(config, false), { ok: true });
  assert.deepEqual(patches[1], { features: { voiceMode: { tts: { provider: "local" } } } });
});

test("connection and restoration must be confirmed by the daemon's patch result", async (t) => {
  const { controls, record } = setup(t);
  const { config } = fakeConfig(local, local, bridged, bridged, local);
  assert.match((await controls.connect(config, true)).error ?? "", /did not set the Read Aloud Base URL/);
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.match((await controls.connect(config, false)).error ?? "", /did not restore Speaking settings/);
  assert.equal(fs.existsSync(record), true);
  assert.deepEqual(await controls.connect(config, false), { ok: true });
  assert.equal(fs.existsSync(record), false);
});

test("the switch cannot connect a stopped bridge or clear an unrelated Base URL", async (t) => {
  const { home, record } = setup(t);
  const { config, patches } = fakeConfig({ ...openai, baseUrl: "https://example.test/v1" });
  const stopped = createVoiceModeControls({ bridge: stoppedBridge, home, env: {} });
  assert.deepEqual(await stopped.connect(config, true), { ok: false, error: "Port in use" });
  assert.deepEqual(await stopped.connect(config, false), { ok: true });
  assert.deepEqual(patches, []);
  assert.equal(fs.existsSync(record), false);
});
