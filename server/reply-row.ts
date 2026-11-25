/// <reference types="node" />
import type { PluginHookContext, PluginHookPayload } from "@getpaseo/plugin/server";
import { READ_ALOUD_KIND } from "../shared/speech";

/** Row data must stay under 64 KiB once serialized; escaping can grow text, so keep a margin. */
const MAX_ROW_TEXT = 30_000;

/**
 * How far back to look for the start of the reply. Streamed replies can be stored as many small
 * chunks, and tool calls sit between them, so 60 entries could cut off the start of a long one.
 */
const LOOKBACK = 500;

/**
 * After each completed turn, add a Read aloud row holding the turn's final reply. The row is a
 * separate timeline item, so Paseo keeps rendering the reply itself (Markdown, code, copy button).
 */
export async function addReadAloudRow(event: PluginHookPayload<"agent.turn.after">, { paseo }: PluginHookContext) {
  if (event.outcome.kind !== "completed") return;
  const timeline = paseo.agents.ref(event.agent.id).timeline;
  const page = await timeline.refetch({ direction: "tail", limit: LOOKBACK });
  // The final reply is the last run of assistant text after the latest user message;
  // streamed replies can be stored as several consecutive chunks.
  const parts: string[] = [];
  for (let index = page.entries.length - 1; index >= 0; index--) {
    const item = page.entries[index].item;
    if (item.type === "assistant_message") {
      parts.unshift(item.text);
      continue;
    }
    if (parts.join("").trim() || item.type === "user_message") break;
  }
  const reply = parts.join("").trim();
  if (!reply) return;
  const last = page.entries[page.entries.length - 1];
  await timeline.append({
    type: "plugin",
    id: "reply-" + (event.turnId ?? String(last?.seqEnd ?? Date.now())),
    kind: READ_ALOUD_KIND,
    version: 1,
    data: { text: reply.slice(0, MAX_ROW_TEXT), createdAt: Date.now() },
  });
}
