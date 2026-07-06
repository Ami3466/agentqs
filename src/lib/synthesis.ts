import { llmComplete, type LlmMessage } from "./llm";
import { activeLlm, type AppConfig } from "./config";
import type { SessionItem } from "./record";
import { skillById } from "./skills";

/**
 * The synthesis layer — Loop 9's core. After a session ends we distill the
 * transcript into {title, summary, insights, commitments} and store THAT (not
 * the raw transcript) as the memory the agent reads next time. Two paths:
 *
 *   with an AI key → the model distills the transcript to strict JSON.
 *   no key         → a deterministic heuristic pulls commitments + a plain
 *                    summary from the user's own words. Honest, never invented.
 *
 * The read side (`continuityBlock`, `continuityFallbackReply`, `openCommitments`)
 * turns prior sessions' synthesis into continuity context for a NEW session, so
 * it can reference an earlier commitment — the loop's ships-when.
 */

export interface SessionSynthesis {
  title: string;
  summary: string;
  insights: string[];
  commitments: string[];
}


const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/** Render the conversation as a plain transcript for the synthesis model. */
export function formatTranscript(messages: LlmMessage[], skill: string): string {
  const other = skillById(skill).name;
  return messages
    .map((m) => `${m.role === "user" ? "You" : other}: ${m.content.trim()}`)
    .join("\n");
}

// ---- Heuristic (no-key) extraction ---------------------------------------

// First-person commitment triggers. Kept tight so it catches real commitments
// ("I'll walk every morning") and not idle chatter.
const COMMIT_RE =
  /\b(?:i['’]ll|i will|i['’]m going to|i am going to|i intend to|i plan to|i promise to|i commit to|next time i['’]ll|next time i will)\b\s+([^.!?\n]+)/gi;

/** Trim a captured commitment clause to a single clean action phrase. */
function cleanCommitment(raw: string): string {
  let t = raw.trim();
  // Stop before a new "and I …" clause so two commitments don't fuse into one.
  t = t.split(/\s+\band\s+i(?:['’]ll| will| am| ['’]m)?\b/i)[0];
  t = t.replace(/^(?:to|that|going to)\s+/i, "");
  t = t.replace(/[\s,;:.!?]+$/, "").trim();
  return truncate(t, 140);
}

/** Pull the concrete "I'll …" commitments out of free text, deduped. */
export function extractCommitments(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  COMMIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMIT_RE.exec(text)) !== null) {
    const c = cleanCommitment(m[1] ?? "");
    if (c.length < 3) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 8) break;
  }
  return out;
}

/** Deterministic synthesis when there is no AI key: the user's own first line
 * becomes the summary/title and we lift any explicit commitments. We never
 * fabricate insights without a model, so insights stays empty here — honest. */
export function heuristicSynthesis(messages: LlmMessage[], _skill: string): SessionSynthesis {
  const firstUser = messages.find((m) => m.role === "user")?.content?.trim() ?? "";
  const firstLine = firstUser.split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const joined = messages.map((m) => m.content).join("\n");
  return {
    title: firstLine ? truncate(firstLine, 48) : "Session",
    summary: firstLine ? truncate(firstLine, 160) : "",
    insights: [],
    commitments: extractCommitments(joined),
  };
}

// ---- LLM extraction -------------------------------------------------------

export function synthesisSystem(): string {
  return [
    "You are a synthesis function inside agentqs, a private life record.",
    "Read a mentor/therapy session transcript and distill it. Output ONLY JSON — no prose, no markdown fence.",
    'Shape: {"title": string, "summary": string, "insights": string[], "commitments": string[]}',
    "- title: <=6 words naming the session's topic.",
    "- summary: 1-2 plain sentences of what was discussed.",
    "- insights: patterns or realizations that surfaced, each a short sentence. [] if none.",
    "- commitments: concrete things the USER said they will do, phrased as short imperatives in their voice. [] if none.",
    "Only include what the transcript supports. Never invent numbers, facts, or commitments the user didn't make.",
  ].join("\n");
}

export function synthesisUser(transcript: string, skill: string, date: string): string {
  return `Session date: ${date}\nPersona: ${skill}\n\nTranscript:\n${transcript}`;
}

function stripFence(out: string): string {
  const s = out.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(s);
  return fence ? fence[1].trim() : s;
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => String(x).trim()).filter((x) => x.length > 0).slice(0, 12)
    : [];

/** Parse the model's JSON synthesis; null when it isn't the expected shape. */
export function parseSynthesisJson(out: string): SessionSynthesis | null {
  try {
    const o = JSON.parse(stripFence(out)) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    return {
      title: typeof o.title === "string" ? o.title.trim() : "",
      summary: typeof o.summary === "string" ? o.summary.trim() : "",
      insights: strArray(o.insights),
      commitments: strArray(o.commitments),
    };
  } catch {
    return null;
  }
}

export interface SynthesizeInput {
  messages: LlmMessage[];
  skill: string;
  date: string;
  cfg?: AppConfig | null;
}

export interface SynthesizeResult {
  synthesis: SessionSynthesis;
  via: "llm" | "heuristic";
  transcript: string;
}

/** Distill one session. Uses the model when a key is set, otherwise the
 * deterministic heuristic. Either way the caller stores the synthesis (separate
 * from daily data) and the agent reads it — never the transcript. */
export async function synthesizeSession(input: SynthesizeInput): Promise<SynthesizeResult> {
  const transcript = formatTranscript(input.messages, input.skill);
  const heur = heuristicSynthesis(input.messages, input.skill);
  const llm = activeLlm(input.cfg ?? null);
  if (!llm) return { synthesis: heur, via: "heuristic", transcript };

  try {
    const out = await llmComplete({
      llm,
      system: synthesisSystem(),
      messages: [{ role: "user", content: synthesisUser(transcript, input.skill, input.date) }],
      maxTokens: 600,
    });
    const parsed = parseSynthesisJson(out);
    if (parsed) {
      return {
        synthesis: {
          title: parsed.title || heur.title,
          summary: parsed.summary || heur.summary,
          insights: parsed.insights,
          // Fall back to the heuristic commitments if the model missed them.
          commitments: parsed.commitments.length ? parsed.commitments : heur.commitments,
        },
        via: "llm",
        transcript,
      };
    }
  } catch {
    /* fall through to the heuristic */
  }
  return { synthesis: heur, via: "heuristic", transcript };
}

// ---- Continuity (read side) ----------------------------------------------

export interface OpenCommitment {
  text: string;
  date: string;
  skill: string;
  sessionId: string;
}

/** Prior sessions, newest first (by start time). */
export function priorSessionsNewestFirst(sessions: SessionItem[]): SessionItem[] {
  return [...sessions].sort((a, b) => cmp(b.startedAt, a.startedAt) || cmp(b.id, a.id));
}

/** Every commitment from past sessions, newest session first — the things the
 * agent should check back in on when a new session opens. */
export function openCommitments(sessions: SessionItem[]): OpenCommitment[] {
  const out: OpenCommitment[] = [];
  for (const s of priorSessionsNewestFirst(sessions)) {
    for (const c of s.commitments) {
      const text = c?.trim();
      if (text) out.push({ text, date: s.date ?? s.startedAt.slice(0, 10), skill: s.skill, sessionId: s.id });
    }
  }
  return out;
}

/**
 * The continuity context injected into the system prompt for a new session —
 * built from synthesis only (summaries, insights, commitments), never the raw
 * transcripts. This is how the agent "remembers" across sessions.
 */
export function continuityBlock(sessions: SessionItem[], limit = 6): string {
  const recent = priorSessionsNewestFirst(sessions).slice(0, limit);
  if (!recent.length) return "";
  const lines: string[] = [
    "--- Memory: synthesis of past sessions (you read these distilled notes, never the raw transcripts) ---",
  ];
  for (const s of recent) {
    const date = s.date ?? s.startedAt.slice(0, 10);
    lines.push(`${date} · ${s.skill} · ${s.title ?? "Session"}${s.summary ? `: ${s.summary}` : ""}`);
    for (const i of s.insights) lines.push(`   insight: ${i}`);
    for (const c of s.commitments) lines.push(`   commitment: ${c}`);
  }
  const open = openCommitments(sessions);
  if (open.length) {
    lines.push("", "Open commitments the user made in past sessions:");
    for (const o of open.slice(0, 8)) lines.push(`- (${o.date}) ${o.text}`);
    lines.push(
      "",
      "When a new session opens, check in on the most relevant open commitment — reference it explicitly and ask how it went before moving on.",
    );
  }
  return lines.join("\n");
}

/**
 * The no-key opener for a fresh session: reference the most recent open
 * commitment so continuity holds even without a model. Returns null when there
 * are no prior commitments (caller uses its generic greeting then).
 */
export function continuityFallbackReply(skillName: string, sessions: SessionItem[]): string | null {
  const open = openCommitments(sessions);
  if (!open.length) return null;
  const c = open[0];
  return (
    `Before anything else — last session (${c.date}) you committed to: “${c.text}”. How did that go?\n\n` +
    `Tell me and we'll pick it up from there. (I'm your ${skillName.toLowerCase()}; add an AI key in Settings for fuller, data-grounded replies.)`
  );
}
