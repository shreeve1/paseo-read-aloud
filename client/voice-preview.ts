import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import type { SpeechFile, SpeechRequest } from "../shared/speech";

type PreviewState = { status: "idle" | "playing" } | { status: "error"; message: string };

export function createVoicePreview() {
  let state: PreviewState = { status: "idle" };
  const listeners = new Set<() => void>();
  function setState(next: PreviewState) {
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reset() {
      if (state.status === "error") setState({ status: "idle" });
    },
    async play({ mode, speak, playAudio }: {
      mode: "personal" | "managed" | "standard" | "local";
      speak: (request: SpeechRequest) => Promise<SpeechFile>;
      playAudio: (audio: SpeechFile) => Promise<void>;
    }) {
      if (state.status === "playing") return;
      setState({ status: "playing" });
      try {
        const audio = await speak(mode === "managed" || mode === "standard"
          ? { text: protocol.pilot.fixture_text, manual: true, ...(mode === "standard" ? { preview: true } : {}) }
          : { text: "Hello. This is how your Read Aloud voice sounds.", ...(mode === "local" ? { manual: true } : {}) });
        await playAudio(audio);
        setState({ status: "idle" });
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "Could not play the test voice." });
        return "failed";
      }
    },
  };
}
