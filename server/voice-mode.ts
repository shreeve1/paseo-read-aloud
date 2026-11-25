import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { paseoHome } from "./paths";
import { LEGACY_BRIDGE_KEY, speechBridgeUrl, type startSpeechBridge } from "./speech-bridge";
import { readDaemonConfig, resolveOpenAiTtsKey } from "./voices";

type ConfigAccess = PluginHandlerContext["paseo"]["config"];
type Config = Awaited<ReturnType<ConfigAccess["get"]>>["config"];
type Patch = Parameters<ConfigAccess["patch"]>[0];

const previousProvider = z.object({ provider: z.string() });
const speaking = (config: Config) => config.features?.voiceMode?.tts;
const connected = (config: Config, bridgeUrl: string) => {
  const tts = speaking(config);
  return tts?.provider === "openai" && tts.baseUrl === bridgeUrl;
};

function readPreviousProvider(file: string) {
  try {
    return previousProvider.parse(JSON.parse(fs.readFileSync(file, "utf8"))).provider;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function restoreRecord(home: string) {
  return path.join(home, "plugin-data", "read-aloud", "voice-mode.json");
}

async function restoreSpeaking(config: ConfigAccess, record: string) {
  const restoreLocal = readPreviousProvider(record) === "local";
  const patch: Patch = { features: { voiceMode: { tts: restoreLocal ? { provider: "local" } : { baseUrl: null } } } };
  const { config: result } = await config.patch(patch);
  const tts = speaking(result);
  const restored = restoreLocal ? tts?.provider === "local" : tts?.provider === "openai" && tts.baseUrl == null;
  if (!restored) return { ok: false, error: "Paseo did not restore Speaking settings. Check Paseo's Speaking settings." };
  fs.rmSync(record, { force: true });
  return { ok: true };
}

export async function restoreManagedSpeaking(config: ConfigAccess): Promise<string | undefined> {
  try {
    const { config: current } = await config.get();
    if (connected(current, speechBridgeUrl())) {
      const result = await restoreSpeaking(config, restoreRecord(paseoHome()));
      return result.error;
    }
  } catch {
    return "Could not restore Paseo's Speaking settings. Check that Speaking uses Local.";
  }
}

export function createVoiceModeControls({
  bridge, env = process.env, home = paseoHome(env),
}: { bridge: Pick<ReturnType<typeof startSpeechBridge>, "status" | "url">; env?: NodeJS.ProcessEnv; home?: string }) {
  const record = restoreRecord(home);
  let queue = Promise.resolve();

  async function status(config: ConfigAccess) {
    const { config: current } = await config.get();
    return { ...bridge.status(), connected: connected(current, bridge.url()), provider: speaking(current)?.provider ?? "local" };
  }

  async function change(config: ConfigAccess, enabled: boolean) {
    const { config: current } = await config.get();
    const bridgeUrl = bridge.url();
    const wasConnected = connected(current, bridgeUrl);
    if (!enabled && !wasConnected) return { ok: true };
    const provider = speaking(current)?.provider ?? "local";
    if (enabled) {
      const key = provider === "openai" ? resolveOpenAiTtsKey(readDaemonConfig(home), env) : undefined;
      const legacyKey = key === LEGACY_BRIDGE_KEY;
      const needsKey = !key || legacyKey;
      if (wasConnected && !needsKey) return { ok: true };
      const { listening, error } = bridge.status();
      if (!listening) return { ok: false, error: error ?? "The Read Aloud speech bridge is not listening." };
      const tts = { provider: "openai", baseUrl: bridgeUrl } as const;
      if (provider !== "openai") {
        // Keep the restore point even if the daemon persists the patch before its reply is lost.
        fs.mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 });
        fs.writeFileSync(record, JSON.stringify({ provider }), { mode: 0o600 });
      } else if (!wasConnected && !legacyKey) {
        fs.rmSync(record, { force: true });
      }
      const next = needsKey ? { ...tts, apiKey: randomBytes(32).toString("base64url") } : tts;
      const patch: Patch = { features: { voiceMode: { tts: next } } };
      const { config: result } = await config.patch(patch);
      return connected(result, bridgeUrl) ? { ok: true }
        : { ok: false, error: "Paseo did not set the Read Aloud Base URL. Check Paseo's Speaking settings." };
    }

    return restoreSpeaking(config, record);
  }

  function connect(config: ConfigAccess, enabled: boolean) {
    // Two devices can change the same host setting. Keep their config and restore-file writes in order.
    const result = queue.then(() => change(config, enabled))
      .catch(() => ({ ok: false, error: "Could not change Paseo's Speaking settings." }));
    queue = result.then(() => undefined);
    return result;
  }

  return { status, connect };
}
