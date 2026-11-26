import { execFile } from "node:child_process";
import type { ManagedSpeed } from "../shared/settings";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };

const PCM_BYTES = protocol.routes.synthesize.response_200.max_bytes;
// At 0.5x the clip can grow to twice its original duration. Allow for filter overlap.
const FILTERED_BYTES = 2 * PCM_BYTES + 24_000;
const TIMEOUT_MS = 5_000;
const PCM_ARGS = ["-f", "s16le", "-ar", "24000", "-ac", "1"];
export const SPEED_UNAVAILABLE = "Central voice needs FFmpeg for other speeds. Choose 1x in Read Aloud settings.";

function ffmpeg(args: string[], { input, maxBuffer, signal }: {
  input?: Buffer; maxBuffer: number; signal?: AbortSignal;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("ffmpeg", args, { encoding: "buffer", maxBuffer, timeout: TIMEOUT_MS, signal, killSignal: "SIGKILL" },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    // A child that cannot start or stops reading closes its end of the pipe.
    // execFile's callback reports the failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export async function isManagedSpeedAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const filters = await ffmpeg(["-hide_banner", "-filters"], { maxBuffer: 131_072, signal });
    return /^\s*\S+\s+atempo\s/m.test(filters.toString("utf8"));
  } catch {
    return false;
  }
}

export async function adjustManagedSpeed(pcm: Buffer, speed: ManagedSpeed, signal: AbortSignal): Promise<Buffer> {
  if (speed === 1) return pcm;
  try {
    const output = await ffmpeg([
      "-hide_banner", "-loglevel", "error", ...PCM_ARGS, "-i", "pipe:0",
      "-af", `atempo=${speed}`, ...PCM_ARGS, "pipe:1",
    ], { input: pcm, maxBuffer: FILTERED_BYTES, signal });
    if (output.length > 0 && output.length % 2 === 0) return output;
  } catch {
    // Give an actionable error without surfacing child process output.
  }
  throw new Error("Could not change the Central voice speed. Choose 1x in Read Aloud settings to play at normal speed.");
}
