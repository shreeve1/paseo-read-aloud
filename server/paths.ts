import os from "node:os";
import path from "node:path";

export function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
}
