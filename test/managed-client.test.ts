import assert from "node:assert/strict";
import { test } from "node:test";
import { canTestVoice, reconcileManagedVoice, shouldAutoRead, voiceSources } from "../client/managed-settings";
import { createPlayer } from "../client/player";
import type { SpeechRequest } from "../shared/speech";

test("managed hosts offer central and local sources and ignore a device's saved auto-read setting", () => {
  for (const mode of ["managed", "managed-unavailable"] as const) {
    assert.deepEqual(voiceSources(mode).map(({ value }) => value), ["paseo", "managed"]);
    assert.equal(shouldAutoRead(mode, true), false);
    assert.equal(canTestVoice(mode), false);
  }
  assert.equal(shouldAutoRead(undefined, true), false);
  assert.equal(canTestVoice(undefined), false);
  assert.deepEqual(voiceSources("personal").map(({ value }) => value), ["paseo", "google"]);
  assert.equal(shouldAutoRead("personal", true), true);
  assert.equal(canTestVoice("personal"), true);
  assert.equal(shouldAutoRead("personal", false), false);
});

test("the picker clears a denied voice even without a fresh approved list", () => {
  const saved = { voiceId: "one", voiceName: "First" };
  assert.equal(reconcileManagedVoice(saved, undefined), saved);
  assert.equal(reconcileManagedVoice(saved, [{ id: "one", name: "First" }]), saved);
  assert.deepEqual(reconcileManagedVoice(saved, [{ id: "one", name: "New name" }]), {
    voiceId: "one", voiceName: "New name",
  });
  const empty = { voiceId: "", voiceName: "" };
  assert.deepEqual(reconcileManagedVoice(saved, [{ id: "two", name: "Second" }]), empty);
  assert.deepEqual(reconcileManagedVoice(saved, []), empty);
  assert.equal(reconcileManagedVoice(empty, [{ id: "two", name: "Second" }]), empty);
  assert.deepEqual(reconcileManagedVoice(saved, undefined, "one"), empty);
  assert.deepEqual(reconcileManagedVoice(saved, [{ id: "one", name: "First" }], "one"), empty);
  assert.equal(reconcileManagedVoice(saved, undefined, "two"), saved);
});

test("only the press path sends manual intent", async () => {
  const requests: SpeechRequest[] = [];
  let played = 0;
  const player = createPlayer({
    async speak(input) {
      requests.push(input);
      return { base64: "", mimeType: "audio/wav" };
    },
    async cancel() {},
    async playAudio() { played++; },
  });
  await player.autoPlay("recent", "One new reply.", Date.now(), "agent", false);
  await player.play("pressed", "One manual reply.", (error) => assert.fail(String(error)), "agent", false);
  player.prefetch("hover", "One hovered reply.");
  assert.deepEqual(requests.map(({ text, automatic, manual, localOnly }) => [text, automatic, manual, localOnly]), [
    ["One new reply.", true, undefined, undefined],
    ["One manual reply.", undefined, true, undefined],
    ["One hovered reply.", undefined, undefined, true],
  ]);
  assert.equal(played, 2);
});
