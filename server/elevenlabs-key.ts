import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paseoHome } from "./paths";

const keyPath = (env?: NodeJS.ProcessEnv) => path.join(paseoHome(env), "plugin-data", "read-aloud", "elevenlabs-key");

export function readKey(env = process.env) {
  const envKey = env.ELEVENLABS_API_KEY?.trim();
  if (envKey) return { source: "env" as const, apiKey: envKey };
  try {
    const fileKey = fs.readFileSync(keyPath(env), "utf8").trim();
    if (fileKey) return { source: "file" as const, apiKey: fileKey };
  } catch {
    // A missing or unreadable file can't configure the provider.
  }
  return { source: "none" as const, apiKey: undefined };
}

export function saveKey(apiKey: string) {
  const file = keyPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temp = file + "." + randomUUID();
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, apiKey, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function clearKey() {
  fs.rmSync(keyPath(), { force: true });
}
