import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlayer, type AudioData, type PlayerHost } from "../client/player.ts";
import { toChunks, toSpeech } from "../shared/text.ts";

const CLIP_MS = 80;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noError = (error: unknown) => assert.fail(`unexpected error: ${String(error)}`);
const reply = (label: string) =>
  Array.from({ length: 6 }, (_, i) => `${label} sentence number ${i} is a fairly ordinary one.`).join(" ");
const CHUNKS = toChunks(toSpeech(reply("A"))).length;

/** A fake Paseo: fast synthesis, and an uninterruptible in-order audio queue like the real one. */
function fakeHost({ synthMs = 5, fail = false } = {}) {
  const log: { session: string; text: string; queuedAt: number; start: number; end: number }[] = [];
  const cancelled: string[] = [];
  let queueEnd = 0;
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  return {
    log,
    cancelled,
    now,
    host: {
      async speak({ text, session }: Parameters<PlayerHost["speak"]>[0]): Promise<AudioData> {
        await wait(synthMs);
        if (fail) throw new Error("voice broke");
        if (cancelled.includes(session)) throw new Error("cancelled");
        return { base64: JSON.stringify({ session, text }), mimeType: "audio/wav", durationMs: CLIP_MS };
      },
      async cancel(session: string) {
        cancelled.push(session);
      },
      playAudio(audio: AudioData) {
        const { session, text } = JSON.parse(audio.base64);
        const start = Math.max(now(), queueEnd);
        queueEnd = start + (audio.durationMs ?? CLIP_MS);
        const entry = { session, text, queuedAt: now(), start, end: queueEnd };
        log.push(entry);
        return wait(entry.end - now());
      },
    },
  };
}

const options = { lookahead: 2, handoffMs: 30 };

test("stop then play again on the same row never plays two streams", async () => {
  const fake = fakeHost();
  const player = createPlayer(fake.host, options);
  const first = player.play("row", reply("A"), noError);
  await wait(CLIP_MS * 0.5);
  player.stop("row");
  const stoppedAt = fake.now();
  assert.equal(player.phase("row"), "stopping");
  // The old bug: pressing play while the stopped clip is still sounding revived the old loop.
  const second = player.play("row", reply("B"), noError);
  await Promise.all([first, second]);

  const sessions = [...new Set(fake.log.map((entry) => entry.session))];
  assert.equal(sessions.length, 2);
  const old = fake.log.filter((entry) => entry.session === sessions[0]);
  assert.ok(old.every((entry) => entry.queuedAt <= stoppedAt), "old press queued audio after Stop");
  assert.equal(old.length, 1, "Stop should leave at most the clip already playing");
  assert.ok(fake.cancelled.includes(sessions[0]), "Stop should cancel the host's queued chunks");
  assert.equal(fake.log.filter((entry) => entry.session === sessions[1]).length, CHUNKS);
  assert.equal(player.phase("row"), "idle");
});

test("clips play back to back with no gaps", async () => {
  const fake = fakeHost();
  const player = createPlayer(fake.host, options);
  await player.play("row", reply("A"), noError);
  assert.ok(CHUNKS >= 3);
  assert.equal(fake.log.length, CHUNKS);
  for (let i = 1; i < fake.log.length; i++) {
    assert.ok(fake.log[i].queuedAt <= fake.log[i - 1].end, `gap before clip ${i}`);
    assert.equal(fake.log[i].start, fake.log[i - 1].end);
  }
});

test("only one clip is ever waiting in Paseo's queue", async () => {
  const fake = fakeHost();
  const player = createPlayer(fake.host, options);
  await player.play("row", reply("A"), noError);
  for (let i = 2; i < fake.log.length; i++) {
    assert.ok(fake.log[i].queuedAt >= fake.log[i - 2].end, `clip ${i} queued too early`);
  }
});

test("stopping lasts until the clip already queued has finished", async () => {
  const fake = fakeHost();
  const player = createPlayer(fake.host, options);
  const run = player.play("row", reply("A"), noError);
  await wait(CLIP_MS * 0.3);
  player.stop("row");
  await wait(CLIP_MS * 0.3);
  assert.equal(player.phase("row"), "stopping");
  await run;
  assert.equal(player.phase("row"), "idle");
  assert.ok(fake.now() >= fake.log[0].end - 2);
});

test("starting another reply stops the first", async () => {
  const fake = fakeHost();
  const player = createPlayer(fake.host, options);
  const first = player.play("a", reply("A"), noError);
  await wait(CLIP_MS * 0.5);
  const second = player.play("b", reply("B"), noError);
  assert.equal(player.phase("a"), "idle");
  assert.equal(player.phase("b"), "loading");
  await Promise.all([first, second]);
  assert.equal(fake.log.filter((entry) => entry.text.startsWith("A")).length, 1);
});

test("a prefetched first chunk is reused, not generated twice", async () => {
  const fake = fakeHost();
  let calls = 0;
  const player = createPlayer({ ...fake.host, speak: (input) => (calls++, fake.host.speak(input)) }, options);
  player.prefetch("row", reply("A"));
  await wait(20);
  await player.play("row", reply("A"), noError);
  assert.equal(calls, CHUNKS);
});

test("each chunk gets its neighbors and prefetch matches the first press request", async () => {
  const text = reply("A");
  const chunks = toChunks(toSpeech(text));
  const requests: Parameters<PlayerHost["speak"]>[0][] = [];
  const player = createPlayer({
    async speak(input) {
      requests.push(input);
      return { base64: "", mimeType: "audio/wav" };
    },
    async cancel() {},
    async playAudio() {},
  });
  const expected = chunks.map((text, index) => ({
    text, agentId: "agent", previous: chunks[index - 1], next: chunks[index + 1],
  }));
  const payloads = () => requests.splice(0).map((request) => {
    const { session, localOnly, ...payload } = request;
    assert.ok(session);
    return payload;
  });

  await player.play("row", text, noError, "agent");
  assert.deepEqual(payloads(), expected);
  player.prefetch("row", text, "agent");
  assert.equal(requests[0].localOnly, true);
  await player.play("row", text, noError, "agent");
  assert.deepEqual(payloads(), expected);
});

test("a synthesis error is reported and the button resets", async () => {
  const fake = fakeHost({ fail: true });
  const player = createPlayer(fake.host, options);
  let reported: unknown;
  await player.play("row", reply("A"), (error) => (reported = error));
  assert.match(String(reported), /voice broke/);
  assert.equal(player.phase("row"), "idle");
});
