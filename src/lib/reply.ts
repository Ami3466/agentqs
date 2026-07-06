import { activeLlm, readConfig } from "./config";
import { dbPath, recordDir } from "./paths";
import { appendInboxItem, rebuild, readSessionsFromRecord } from "./record";
import { groundedCrossSourceAnswer, looksLikeDataQuestion, looksLikeRecallQuestion, readGrounding } from "./grounding";
import { answerRecall } from "./embeddings";
import { continuityBlock, continuityFallbackReply } from "./synthesis";
import { dailyCatalog, resolveModel, runMentor } from "./agent";
import { modeOf, memoText } from "./smart-input";
import { resolveSkill } from "./skills-store";
import type { LlmMessage } from "./llm";

/**
 * The channel-agnostic reply brain (Loop 14). One inbound line of text — from a
 * Telegram DM, a Slack message, or anywhere else — is turned into a reply the same
 * way the Chat box does, but NON-streaming (a bot posts one message back):
 *
 *   `>>` memo     → appended raw to the inbox (source = the channel), no LLM, no
 *                   daily row; the reply is a short "saved" ack — exactly the
 *                   "saved, no reply" chip from the UI.
 *   plain text /  → the grounded mentor. With an AI key it's the tool-using agent
 *   a question       (runMentor: query_daily + search_notes over the record). With
 *                    no key a cross-source data question is still answered
 *                    deterministically from the numbers, else a persona/continuity
 *                    note. Either way the reply cites the user's real record.
 *
 * This is the single funnel every channel adapter calls, so a new transport is a
 * thin I/O shell (parse inbound → composeReply → send out) and never re-implements
 * the brain. Server-only (fs + sqlite + providers).
 */

export interface ComposedReply {
  mode: "memo" | "chat";
  text: string; // what to send back to the user
  grounded: boolean; // did the answer draw on real record data?
  sources: string[]; // daily sources the answer cited
  metrics: string[]; // daily metrics the answer cited
  via: "memo" | "agent" | "cross-source" | "recall" | "continuity" | "fallback";
}

export interface ComposeReplyInput {
  message: string;
  channel: string; // "telegram" | "slack" — the inbox source for a memo
  skill?: string | null;
  history?: LlmMessage[];
}

/** Turn one inbound message into a reply. Mirrors the Chat route's decision tree
 *  (memo vs keyed agent vs keyless grounded vs continuity) without streaming. */
export async function composeReply(input: ComposeReplyInput): Promise<ComposedReply> {
  const raw = input.message.trim();
  const skill = resolveSkill(input.skill);
  const mode = modeOf(raw);

  // ---- Memo: land it raw in the inbox, no LLM, and ack. -------------------
  if (mode === "memo") {
    const text = memoText(raw);
    const rDir = recordDir();
    if (!text) {
      return { mode: "memo", text: "Nothing to save — send `>> your note`.", grounded: false, sources: [], metrics: [], via: "memo" };
    }
    appendInboxItem({ text, source: input.channel || "memo", kind: "text" }, { recordDir: rDir });
    rebuild({ recordDir: rDir });
    return {
      mode: "memo",
      text: `Saved to your inbox. No reply — press Structure in the app when you want it turned into data.`,
      grounded: false,
      sources: [],
      metrics: [],
      via: "memo",
    };
  }

  // A `/command` from a bot has no palette here — answer it like a chat line so the
  // user still gets a useful, grounded reply (the app's Chat box owns the palette).
  const message = mode === "command" ? raw.replace(/^\//, "").trim() : raw;

  const cfg = readConfig();
  const llm = activeLlm(cfg);
  const history = Array.isArray(input.history)
    ? input.history
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-10)
    : [];
  const sessionStart = history.length === 0;

  const prior = readSessionsFromRecord(recordDir());
  const grounding = readGrounding();

  // ---- No key: honest fallback, but a data question over ≥2 sources still gets a
  // real, grounded cross-source answer computed straight from the numbers. --------
  if (!llm) {
    // Semantic recall ("find days that felt like this") — the local index answers it
    // with no key. Most specific intent, so checked first.
    if (looksLikeRecallQuestion(message)) {
      const recall = await answerRecall(message, history);
      if (recall) {
        return {
          mode: "chat",
          text: recall.text,
          grounded: true,
          sources: recall.sources,
          metrics: [],
          via: "recall",
        };
      }
    }
    if (grounding.sources.length >= 2 && looksLikeDataQuestion(message)) {
      const answer = groundedCrossSourceAnswer(grounding, message);
      if (answer) {
        return {
          mode: "chat",
          text: answer.text,
          grounded: true,
          sources: answer.sources,
          metrics: answer.metrics,
          via: "cross-source",
        };
      }
    }
    const opener = sessionStart ? continuityFallbackReply(skill.name, prior) : null;
    if (opener) {
      return { mode: "chat", text: opener, grounded: false, sources: [], metrics: [], via: "continuity" };
    }
    return {
      mode: "chat",
      text:
        `I'm your ${skill.name.toLowerCase()}. Add an AI key in Settings and I'll answer this grounded in your real data. ` +
        `Until then, send \`>> a note\` and I'll keep your record building.`,
      grounded: false,
      sources: [],
      metrics: [],
      via: "fallback",
    };
  }

  // ---- With a key: the tool-using mentor agent, grounded in the record. ---------
  const dbFile = dbPath();
  const catalog = dailyCatalog(dbFile);
  const memory = continuityBlock(prior);
  const system = [skill.system, catalog.hint, memory].filter(Boolean).join("\n\n");
  const model = resolveModel(llm);

  const run = await runMentor({
    model,
    system,
    messages: [...history, { role: "user", content: message }],
    dbFile,
  });

  return {
    mode: "chat",
    text: run.text || "…",
    grounded: run.grounded,
    sources: run.grounded && !run.sources.length ? grounding.sources : run.sources,
    metrics: run.metrics,
    via: "agent",
  };
}
