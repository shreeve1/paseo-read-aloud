import assert from "node:assert/strict";
import { test } from "node:test";
import { centralChunks } from "../client/central-chunks";
import { createPlayer, type PlayerHost } from "../client/player";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import { toSpeech } from "../shared/text";
import { deferred } from "./deferred";

const voiceId = "one";
const permit = "1".repeat(64);
const ready = { kind: "ready", permit, voiceId } as const;
const limited = { kind: "wait", seconds: 1, message: "Rate limited." } as const;
const reply = Array.from({ length: 25 }, (_, i) => `Sentence ${i} has several words for testing.`).join(" ");
const noError = (error: unknown) => assert.fail(String(error));

test("Central chunks use the available UTF-8 wire budget and preserve words and code points", () => {
  const text = toSpeech(reply);
  const chunks = centralChunks(text, voiceId);
  assert.equal(chunks.join(" "), text);
  assert.ok(chunks.length <= 6 && chunks.length > 1);
  const input = '𠮷"\\'.repeat(280) + "𠮷";
  const longerId = "x".repeat(3750);
  const unicode = centralChunks(input, longerId);
  assert.equal(unicode.join(""), input);
  for (const text of unicode) {
    assert.ok([...text].length <= 250);
    assert.equal(Buffer.from(text).toString(), text);
    assert.ok(Buffer.byteLength(JSON.stringify({ voice_id: longerId, text })) <= protocol.limits.max_request_bytes);
  }
});

function hosts() {
  type Central = NonNullable<PlayerHost["central"]>;
  const played: string[] = [];
  const sent: string[] = [];
  const ended: string[] = [];
  let checks = 0;
  const central: Central = {
    async start() { checks++; return ready; },
    async chunk({ session, permit: token, index, text }) {
      assert.ok(session);
      assert.equal(token, permit);
      assert.equal(index, sent.length);
      sent.push(text);
      return { kind: "audio", audio: { base64: text, mimeType: "audio/wav" } };
    },
    async end({ permit }) { ended.push(permit); },
  };
  const host: PlayerHost = {
    central,
    async speak() { throw new Error("Central playback used the legacy handler."); },
    async cancel() { throw new Error("Central playback used legacy cancellation."); },
    async playAudio(clip) { played.push(clip.base64); },
  };
  return { host, central, played, sent, ended, checks: () => checks };
}

test("one permission check plays ordered clips with at most one outstanding request and never queues behind audio", async () => {
  const { host, central, played, sent, ended, checks } = hosts();
  const { promise: holdClip, resolve: finishClip } = deferred<void>();
  const { promise: secondRequested, resolve: next } = deferred<void>();
  const generate = central.chunk;
  let active = false;
  central.chunk = async (input) => {
    assert.equal(active, false);
    active = true;
    const result = await generate(input);
    active = false;
    if (input.index === 1) next();
    return result;
  };
  host.playAudio = async (audio) => {
    played.push(audio.base64);
    if (played.length === 1) await holdClip;
  };
  const player = createPlayer(host);
  const playback = player.playCentral("row", reply, noError);
  await secondRequested;
  assert.equal(played.length, 1);
  assert.equal(sent.length, 2);
  finishClip();
  await playback;
  assert.equal(checks(), 1);
  assert.equal(played.join(" "), reply);
  assert.deepEqual(played, sent);
  assert.deepEqual(ended, [permit]);
  assert.equal(player.phase("row"), "idle");
});

test("typed rate waits are visible and Stop cancels the wait and all future chunks", async () => {
  const { host, central, played, sent, ended } = hosts();
  const generate = central.chunk;
  central.chunk = async (input) => input.index === 0 ? generate(input) : limited;
  const player = createPlayer(host);
  const { promise: waiting, resolve: markWaiting } = deferred<void>();
  player.subscribe(() => { if (player.phase("row") === "waiting") markWaiting(); });
  const playback = player.playCentral("row", reply, noError);
  await waiting;
  player.stop("row");
  await playback;
  assert.equal(player.phase("row"), "idle");
  assert.equal(sent.length, 1);
  assert.equal(played.length, 1);
  assert.deepEqual(ended, [permit]);
});

test("Stop drains only current audio, drops a late chunk and never waits for the old RPC", async () => {
  const { host, central, played, ended } = hosts();
  const { promise: holdClip, resolve: finishClip } = deferred<void>();
  const { promise: holdChunk, resolve: finishChunk } = deferred<Awaited<ReturnType<typeof central.chunk>>>();
  const { promise: secondRequested, resolve: next } = deferred<void>();
  const generate = central.chunk;
  central.chunk = async (input) => {
    if (input.index === 0) return generate(input);
    next();
    return holdChunk;
  };
  host.playAudio = async (audio) => { played.push(audio.base64); await holdClip; };
  const player = createPlayer(host);
  const playback = player.playCentral("row", reply, noError);
  await secondRequested;
  player.stop("row");
  assert.equal(player.phase("row"), "stopping");
  finishClip();
  await playback;
  assert.equal(player.phase("row"), "idle");
  finishChunk({ kind: "audio", audio: { base64: "late", mimeType: "audio/wav" } });
  await holdChunk;
  assert.equal(played.length, 1);
  assert.deepEqual(ended, [permit]);
});

test("a Wait retries a permission check and a chunk once, while other failures never retry", async () => {
  const { host, central, played } = hosts();
  let checks = 0;
  let chunks = 0;
  central.start = async () => (++checks === 1 ? limited : ready);
  central.chunk = async () => { chunks++; return limited; };
  const errors: unknown[] = [];
  const player = createPlayer(host);
  await player.playCentral("row", reply, (error) => errors.push(error));
  assert.equal(checks, 2);
  assert.equal(chunks, 2);
  assert.equal(played.length, 0);
  assert.match(String(errors[0]), /Rate limited/);
  central.chunk = async () => { chunks++; throw new Error("Cancelled by hub"); };
  await player.playCentral("row", reply, (error) => errors.push(error));
  assert.equal(checks, 3);
  assert.equal(chunks, 3);
  assert.match(String(errors[1]), /Cancelled by hub/);
});
