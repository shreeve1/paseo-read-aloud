import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { loadMode } from "../server/managed";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };

export const dummyBearer = "dummy.hosted.login.credential";

export async function mockHub(
  t: TestContext,
  reply: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  serverName = "localhost",
  caName = "Read Aloud test CA",
) {
  const dir = mkdtempSync(".managed-test-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    config: join(dir, "config", "managed.json"),
    ca: join(dir, "ca", "ca.pem"),
    helper: join(process.cwd(), dir, "helper", "credential"),
  };
  for (const parent of ["config", "ca", "helper"]) mkdirSync(join(dir, parent), { mode: 0o700 });
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc",
    "-days", "1", "-subj", `/CN=${caName}`, "-keyout", "ca.key", "-out", "ca.pem");
  openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc",
    "-subj", `/CN=${serverName}`, "-keyout", "server.key", "-out", "server.csr");
  writeFileSync(join(dir, "san"), `subjectAltName=DNS:${serverName}\n`);
  openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-days", "1", "-extfile", "san", "-out", "server.pem");
  const cert = readFileSync(join(dir, "server.pem"));
  const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
  const server = createServer({ key: readFileSync(join(dir, "server.key")), cert }, async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString("utf8");
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    await reply(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock hub has no TCP address");
  const origin = `https://localhost:${address.port}`;
  writeFileSync(files.config, JSON.stringify({ version: protocol.version, origin }), { mode: 0o644 });
  copyFileSync(join(dir, "ca.pem"), files.ca);
  chmodSync(files.ca, 0o644);
  function helper(script: string) {
    writeFileSync(files.helper, "#!/bin/sh\n" + script + "\n");
    chmodSync(files.helper, 0o755);
  }
  helper(`printf '%s\\n' '${dummyBearer}'`);
  const ownerUid = process.getuid!();
  const load = () => loadMode(files, ownerUid);
  const mode = load();
  if (mode.kind !== "managed") throw new Error("Could not load the test hub");
  return { hub: mode.hub, mode, origin, files, requests, helper, load, ownerUid };
}
