import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileManagedVoice, shouldAutoRead, voicePickerOptions, voiceSources } from "../client/managed-settings";
import { createPlayer } from "../client/player";
import { createVoicePreview } from "../client/voice-preview";
import { voiceSettings } from "../shared/settings";
import type { SpeechFile, SpeechRequest } from "../shared/speech";

test("managed hosts offer central and local sources and ignore a device's saved auto-read setting", () => {
  for (const mode of ["managed", "managed-unavailable"] as const) {
    assert.deepEqual(voiceSources(mode).map(({ value }) => value), ["paseo", "managed"]);
    assert.equal(shouldAutoRead(mode, true), false);
  }
  assert.equal(shouldAutoRead(undefined, true), false);
  assert.deepEqual(voiceSources("personal").map(({ value }) => value), ["paseo", "google"]);
  assert.equal(shouldAutoRead("personal", true), true);
  assert.equal(shouldAutoRead("personal", false), false);
});

test("the picker clears a denied voice even without a fresh approved list", () => {
  const saved = voiceSettings.schema.parse({ managed: { voiceId: "one", voiceName: "First", speed: 1.5 } }).managed;
  assert.equal(reconcileManagedVoice(saved, undefined), saved);
  assert.equal(reconcileManagedVoice(saved, [{ id: "one", name: "First" }]), saved);
  assert.deepEqual(reconcileManagedVoice(saved, [{ id: "one", name: "New name" }]), {
    voiceId: "one", voiceName: "New name", speed: 1.5,
  });
  const empty = { voiceId: "", voiceName: "", speed: saved.speed };
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

test("search filters approved names and keeps the saved voice visible", () => {
  const current = { id: "one", name: "Aoede" };
  const match = { id: "two", name: "Charon" };
  const voices = [current, match, { id: "three", name: "Kore" }];
  assert.deepEqual(voicePickerOptions(voices, "one", " CHAR "), {
    matching: [match],
    options: [{ value: "one", label: "Aoede" }, { value: "two", label: "Charon" }],
  });
  assert.deepEqual(voicePickerOptions(voices, "one", "unknown").matching, []);
});

test("older settings keep the saved voice and personal options when speed defaults to 1x", () => {
  const old = { provider: "managed", managed: { voiceId: "one", voiceName: "Aoede" }, google: { speed: 1.25 } };
  const upgraded = voiceSettings.schema.parse(old);
  assert.deepEqual(upgraded.managed, { voiceId: "one", voiceName: "Aoede", speed: 1 });
  assert.equal(upgraded.google.speed, 1.25);
  assert.equal(voiceSettings.schema.safeParse({ ...old, managed: { ...old.managed, speed: 1.37 } }).success, false);
});

function deferred<T>() {
  let release: (value: T) => void = () => assert.fail("The test promise was not initialized");
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}

test("Settings preview submits one fixed manual speech request, even while audio is playing", async () => {
  const preview = createVoicePreview();
  const requests: SpeechRequest[] = [];
  const audio = { base64: "dummy", mimeType: "audio/wav", durationMs: 500 };
  const response = deferred<typeof audio>();
  const playback = deferred<void>();
  const started = deferred<void>();
  const options = {
    mode: "managed" as const,
    async speak(request: SpeechRequest) {
      requests.push(request);
      return response.promise;
    },
    async playAudio(clip: SpeechFile) {
      assert.equal(clip, audio);
      started.resolve();
      await playback.promise;
    },
  };

  const first = preview.play(options);
  assert.equal(preview.getSnapshot().status, "playing");
  await preview.play(options);
  response.resolve(audio);
  await started.promise;
  await preview.play(options);
  assert.equal(preview.getSnapshot().status, "playing");
  assert.deepEqual(requests, [{ text: "The blue notebook is on the shelf.", manual: true }]);
  playback.resolve();
  await first;
  assert.equal(preview.getSnapshot().status, "idle");
});

test("Settings preview surfaces synthesis and playback failures and can retry", async () => {
  const preview = createVoicePreview();
  let played = 0;
  const speak = async () => ({ base64: "dummy", mimeType: "audio/wav" });
  const playAudio = async () => { played++; };
  await preview.play({
    mode: "managed",
    speak: async () => { throw new Error("The monthly Central voice allowance has been used."); },
    playAudio,
  });
  assert.deepEqual(preview.getSnapshot(), { status: "error", message: "The monthly Central voice allowance has been used." });
  assert.equal(played, 0);
  await preview.play({
    mode: "managed", speak,
    playAudio: async () => { throw new Error("Speaker disconnected."); },
  });
  assert.deepEqual(preview.getSnapshot(), { status: "error", message: "Speaker disconnected." });
  await preview.play({ mode: "managed", speak, playAudio });
  assert.equal(played, 1);
  assert.equal(preview.getSnapshot().status, "idle");
});
