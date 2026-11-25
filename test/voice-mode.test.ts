import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BRIDGE_URL } from "../server/speech-bridge.ts";
import { createVoiceModeControls } from "../server/voice-mode.ts";

type ConfigAccess = Parameters<ReturnType<typeof createVoiceModeControls>["status"]>[0];
type Config = Awaited<ReturnType<ConfigAccess["get"]>>["config"];
type Patch = Parameters<ConfigAccess["patch"]>[0];
type VoiceMode = NonNullable<Config["features"]>["voiceMode"];
type Tts = VoiceMode["tts"];

const local = { provider: "local" } as const;
const openai = { provider: "openai", hasApiKey: true, model: "tts-1-hd", voice: "onyx" } as const;
const bridged = { ...openai, baseUrl: BRIDGE_URL };

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

function setup(t: TestContext) {
  const home = fs.mkdtempSync(path.join(import.meta.dirname, ".voice-mode-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const record = path.join(home, "plugin-data", "read-aloud", "voice-mode.json");
  const controls = createVoiceModeControls({ bridgeStatus: () => ({ listening: true, error: undefined }), home });
  return { controls, home, record };
}

test("connecting an OpenAI setup patches only the Base URL and disabling clears it", async (t) => {
  const { controls, record } = setup(t);
  const { config, patches } = fakeConfig(openai, bridged, openai);
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.deepEqual(await controls.status(config), { listening: true, error: undefined, connected: true, provider: "openai" });
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.deepEqual(await controls.connect(config, false), { ok: true });
  assert.equal((await controls.status(config)).connected, false);
  assert.deepEqual(patches, [
    { features: { voiceMode: { tts: { provider: "openai", baseUrl: BRIDGE_URL } } } },
    { features: { voiceMode: { tts: { baseUrl: null } } } },
  ]);
});

test("connecting Local saves the provider and disabling restores it even after a plugin restart", async (t) => {
  const { controls, home, record } = setup(t);
  const { config, patches } = fakeConfig(local, bridged, local);
  assert.equal((await controls.status(config)).provider, "local");
  assert.deepEqual(await controls.connect(config, true), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), { provider: "local" });
  const restarted = createVoiceModeControls({
    bridgeStatus: () => ({ listening: false, error: "Port in use" }), home,
  });
  assert.deepEqual(await restarted.status(config), { listening: false, error: "Port in use", connected: true, provider: "openai" });
  assert.deepEqual(await restarted.connect(config, false), { ok: true });
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(patches, [
    { features: { voiceMode: { tts: { provider: "openai", baseUrl: BRIDGE_URL, apiKey: "read-aloud-bridge" } } } },
    { features: { voiceMode: { tts: { provider: "local" } } } },
  ]);
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
  const stopped = createVoiceModeControls({ bridgeStatus: () => ({ listening: false, error: "Port in use" }), home });
  assert.deepEqual(await stopped.connect(config, true), { ok: false, error: "Port in use" });
  assert.deepEqual(await stopped.connect(config, false), { ok: true });
  assert.deepEqual(patches, []);
  assert.equal(fs.existsSync(record), false);
});
