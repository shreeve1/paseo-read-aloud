import assert from "node:assert/strict";
import { chmodSync, copyFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { HubError, loadMode } from "../server/managed";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import { dummyBearer, mockHub } from "./managed-fixture";

const fixtureText = protocol.pilot.fixture_text;

test("only an absent config selects personal mode; unsafe or broken files leave managed mode unavailable", async (t) => {
  const { files, load, ownerUid } = await mockHub(t, () => assert.fail("Unexpected request"));
  assert.equal(loadMode(files, ownerUid + 1).kind, "managed-unavailable");
  for (const file of Object.values(files)) {
    chmodSync(file, 0o775);
    assert.equal(load().kind, "managed-unavailable", file);
    chmodSync(file, 0o755);
    const parent = dirname(file);
    for (const mode of [0o720, 0o702]) {
      chmodSync(parent, mode);
      assert.equal(load().kind, "managed-unavailable", parent);
    }
    chmodSync(parent, 0o700);
  }
  writeFileSync(files.ca, "not a certificate");
  assert.equal(load().kind, "managed-unavailable");

  renameSync(files.config, files.config + ".old");
  chmodSync(dirname(files.config), 0o770);
  assert.equal(load().kind, "managed-unavailable");
  chmodSync(dirname(files.config), 0o700);
  assert.deepEqual(load(), { kind: "personal" });
  symlinkSync("missing.json", files.config);
  assert.equal(load().kind, "managed-unavailable");
});

test("a trusted hub receives only the specified routes and the current hosted credential", async (t) => {
  const { hub, requests, helper } = await mockHub(t, (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"voices":[{"id":"one","name":"First"}]}');
    } else {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "X-Audio-Format": "pcm_s16le_24000_mono" })
        .end(Buffer.from([0, 1, 2, 3]));
    }
  });
  assert.deepEqual(await hub.voices(), { voices: [{ id: "one", name: "First" }] });
  const rotated = dummyBearer + ".rotated";
  helper(`printf '%s\\n' '${rotated}'`);
  assert.deepEqual(await hub.synthesize("one", fixtureText), Buffer.from([0, 1, 2, 3]));
  assert.deepEqual(requests, [
    { method: "GET", url: "/v1/speech/voices", authorization: `Bearer ${dummyBearer}`, body: "" },
    { method: "POST", url: "/v1/speech/synthesize", authorization: `Bearer ${rotated}`,
      body: JSON.stringify({ voice_id: "one", text: fixtureText }) },
  ]);
});

test("a wrong CA receives neither bearer nor text", async (t) => {
  const target = await mockHub(t, () => assert.fail("Untrusted server received an HTTP request"));
  const other = await mockHub(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"voices":[]}');
  }, "localhost", "Second Read Aloud test CA");
  assert.deepEqual(await other.hub.voices(), { voices: [] });
  copyFileSync(other.files.ca, target.files.ca);
  const mode = target.load();
  assert.equal(mode.kind, "managed");
  await assert.rejects(mode.hub.synthesize("one", fixtureText), { code: "unreachable" });
  assert.deepEqual(target.requests, []);
});

test("a valid CA with a wrong hostname receives neither bearer nor text", async (t) => {
  const { hub, requests } = await mockHub(t, () => assert.fail("Wrong hostname received an HTTP request"), "wrong.invalid");
  await assert.rejects(hub.synthesize("one", fixtureText), { code: "unreachable" });
  assert.deepEqual(requests, []);
});

test("redirect is rejected, including to another route on the same trusted hub", async (t) => {
  const { hub, requests } = await mockHub(t, (_request, response) => {
    response.writeHead(307, { Location: "/redirected", "Content-Type": "application/json" }).end("{}");
  });
  await assert.rejects(hub.synthesize("one", fixtureText), { code: "invalid_response" });
  assert.deepEqual(requests.map(({ url }) => url), ["/v1/speech/synthesize"]);
});

test("oversize or wrong-format responses cannot become speech or picker options", async (t) => {
  type Reply = (response: import("node:http").ServerResponse) => void;
  let send: Reply = () => assert.fail("Set a response first");
  const { hub, requests } = await mockHub(t, (_request, response) => send(response));
  const audio = { "Content-Type": "application/octet-stream", "X-Audio-Format": "pcm_s16le_24000_mono" };
  for (const reply of [
    (res) => res.writeHead(200, { ...audio, "Content-Type": "audio/mpeg" }).end("xx"),
    (res) => res.writeHead(200, { "Content-Type": audio["Content-Type"] }).end("xx"),
    (res) => res.writeHead(200, { ...audio, "X-Audio-Format": "mp3" }).end("xx"),
    (res) => res.writeHead(200, audio).end("x"),
    (res) => res.writeHead(200, audio).end(),
    (res) => res.writeHead(200, audio).end(Buffer.alloc(protocol.routes.synthesize.response_200.max_bytes + 2)),
  ] satisfies Reply[]) {
    send = reply;
    await assert.rejects(hub.synthesize("one", fixtureText), { code: "invalid_response" });
  }
  for (const reply of [
    (res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"voices":[3]}'),
    (res) => res.writeHead(200, { "Content-Type": "application/json" })
      .end(" ".repeat(protocol.routes.voices.response_200.max_bytes + 1)),
    (res) => res.writeHead(200, { "Content-Type": "application/json",
      "Content-Length": protocol.routes.voices.response_200.max_bytes + 1 }).end(),
  ] satisfies Reply[]) {
    send = reply;
    await assert.rejects(hub.voices(), { code: "invalid_response" });
  }
  const count = requests.length;
  await assert.rejects(hub.synthesize("one", "🎵".repeat(501)), { code: "too_large" });
  await assert.rejects(hub.synthesize("x".repeat(4096), fixtureText), { code: "too_large" });
  assert.equal(requests.length, count);
});

test("every protocol error explains the problem, offers local playback and hides raw hub messages", async (t) => {
  let code = "";
  let status = 400;
  const { hub } = await mockHub(t, (_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: { code, message: dummyBearer } }));
  });
  const messages = new Set<string>();
  for (const [error, errorStatus] of Object.entries(protocol.errors.codes)) {
    code = error;
    status = errorStatus;
    await assert.rejects(hub.voices(), (err: unknown) => {
      assert.ok(err instanceof HubError);
      assert.equal(err.code, code);
      assert.match(err.message, /local playback/);
      assert.ok(!err.message.includes(dummyBearer));
      messages.add(err.message);
      return true;
    });
  }
  assert.equal(messages.size, Object.keys(protocol.errors.codes).length);
  for (const [unknown, mismatchedStatus] of [["made_up", 400], ["__proto__", 400], ["unauthorized", 429]] as const) {
    code = unknown;
    status = mismatchedStatus;
    await assert.rejects(hub.voices(), { code: "invalid_response" });
  }
});

test("bad helper output, nonzero exit and timeout do not start an HTTP request", async (t) => {
  const { hub, requests, helper } = await mockHub(t, () => assert.fail("Unexpected request"));
  for (const script of [
    "printf 'short\\n'",
    `printf '%s' '${dummyBearer}'`,
    `printf '%s\\n\\n' '${dummyBearer}'`,
    `printf '%s\\r\\n' '${dummyBearer}'`,
    `printf '%s\\n' '${dummyBearer}'; exit 1`,
    "exec sleep 30",
  ]) {
    helper(script);
    await assert.rejects(hub.voices(), (error: unknown) => {
      assert.ok(error instanceof HubError);
      assert.equal(error.code, "credential_unavailable");
      assert.ok(!error.message.includes(dummyBearer));
      return true;
    });
  }
  assert.deepEqual(requests, []);
});
