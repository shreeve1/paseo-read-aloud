import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileManagedVoice, shouldAutoRead, voiceSources } from "../client/managed-settings";
import { createPlayer } from "../client/player";
import type { SpeechRequest } from "../shared/speech";

test("managed hosts offer central and local sources and ignore a device's saved auto-read setting", () => {
  for (const mode of ["managed", "managed-unavailable"] as const) {
    assert.deepEqual(voiceSources(mode).map(({ value }) => value), ["paseo", "managed"]);
    assert.equal(shouldAutoRead(mode, true), false);
  }
  assert.equal(shouldAutoRead(undefined, true), false);
  assert.deepEqual(voiceSources("personal").map(({ value }) => value), ["paseo", "elevenlabs"]);
  assert.equal(shouldAutoRead("personal", true), true);
  assert.equal(shouldAutoRead("personal", false), false);
});

test("reconcile persists a removed voice as empty only after a successful list", () => {
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
});

test("the player marks requests from automatic reading so the server can decline them", async () => {
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
  assert.deepEqual(requests.map(({ text, automatic }) => [text, automatic]), [
    ["One new reply.", true], ["One manual reply.", undefined],
  ]);
  assert.equal(played, 2);
});
