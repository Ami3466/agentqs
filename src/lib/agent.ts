import fs from "fs";
import path from "path";
import { generateText, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { openReadonly } from "./db";
import { semanticSearch } from "./embeddings";
import { findSimilarImages, photoContext } from "./photos";
import { fallbackModel, type ResolvedLlm } from "./models";
import { appendInboxItem, rebuild } from "./record";
import { recordDir } from "./paths";
import { autoStructureNewItem, structurePending } from "./structure-run";
import type { LlmMessage } from "./llm";

/**
 * The mentor brain (Loop 4). A provider-agnostic agent built on the Vercel AI SDK
 * (default Anthropic/Claude, BYO key can pick OpenAI or Gemini) that answers from
 * the user's real record by *calling tools*, not by having numbers stuffed into its
 * prompt:
 *
 *   - query_daily  — run a read-only SQL SELECT over the long/tidy `daily` table
 *                    and get real numbers back.
 *   - search_notes — FTS5 keyword search over memos + past sessions (qualitative
 *                    context, never the daily numbers).
 *
 * The persona (mentor / therapist / coach) is the system prompt; a compact schema
 * catalog tells the model what's queryable so it can decide the SQL itself. Every
 * tool run is against the read-only SQLite cache — the model can read the record
 * but never mutate it. Server-only (fs + sqlite + native providers).
 */

// ---- Provider selection ---------------------------------------------------

/** Resolve a provider account (protocol + key + base + model) into a Vercel AI SDK
 *  LanguageModel. Base URL is honoured so OpenRouter / Groq / any custom
 *  OpenAI-compatible endpoint work exactly like OpenAI itself. */
export function resolveModel(r: ResolvedLlm): LanguageModel {
  const id = fallbackModel(r.type, r.model);
  const baseURL = r.baseUrl?.trim() || undefined;
  switch (r.protocol) {
    case "anthropic":
      return createAnthropic({ apiKey: r.apiKey, baseURL })(id);
    case "google":
      return createGoogleGenerativeAI({ apiKey: r.apiKey, baseURL })(id);
    case "openai":
      return createOpenAI({ apiKey: r.apiKey, baseURL })(id);
    default:
      throw new Error(`Unknown provider protocol "${r.protocol}".`);
  }
}

// ---- Read-only SQL over the daily table -----------------------------------

const ROW_CAP = 500;

/** Reject anything that isn't a single read-only SELECT/WITH. The connection is
 *  already read-only (query_only=ON), so this is defence-in-depth + a clean error
 *  the model can recover from by rewriting its SQL. */
function assertSelect(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s === "") throw new Error("Empty query.");
  if (s.includes(";")) throw new Error("Only a single statement is allowed.");
  if (!/^(with|select)\b/i.test(s)) throw new Error("Only read-only SELECT / WITH queries are allowed.");
  return s;
}

/** What a run actually touched — accumulated by the tools as they execute, read by
 *  the caller afterwards to attribute the "grounded in your record" badge. */
export interface Used {
  sources: Set<string>;
  metrics: Set<string>;
  hits: number; // rows + matches returned across every tool call
}

/** Split a natural query into an FTS5-safe OR of quoted terms (raw user text can
 *  contain characters FTS5 treats as operators and would reject). */
function ftsQuery(q: string): string {
  const terms = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/** The two tools the mentor can call. `used` accumulates what the run actually
 *  touched so the caller can attribute the answer (the "grounded in your record"
 *  badge + its source list). */
export function mentorTools(dbFile: string, used: Used) {
  const query_daily = tool({
    description:
      "Run a read-only SQL SELECT over the local `daily` table and get the user's real numbers back. " +
      "The table is long/tidy — columns: date (TEXT, ISO day), source (TEXT), metric (TEXT), value_num (REAL, the number), value_text (TEXT, raw cell). " +
      "When present, the detail store (every point behind the daily rollups) is attached under the `detail` schema: `detail.chrome_visits` (ts, domain, category, title, url) and `detail.heart_rate` (datetime, timestamp_ms, hr). " +
      "One row per (date, source, metric). Always SELECT the `source` column so citations are attributed. " +
      "Example: SELECT date, source, metric, value_num FROM daily WHERE source='whoop' AND metric='sleep_hours' ORDER BY date DESC LIMIT 14.",
    inputSchema: z.object({
      sql: z.string().describe("A single read-only SELECT (or WITH) over the daily table."),
    }),
    execute: async ({ sql }) => {
      if (!fs.existsSync(dbFile)) return { rowCount: 0, rows: [], note: "No data in the record yet." };
      let db;
      try {
        const safe = assertSelect(sql);
        db = openReadonly(dbFile);
        const stmt = db.prepare(safe);
        const rows = (stmt.all() as Record<string, unknown>[]).slice(0, ROW_CAP);
        for (const r of rows) {
          if (typeof r.source === "string") used.sources.add(r.source);
          if (typeof r.metric === "string") used.metrics.add(r.metric);
        }
        used.hits += rows.length;
        return { rowCount: rows.length, rows };
      } catch (e) {
        return { error: (e as Error).message };
      } finally {
        db?.close();
      }
    },
  });

  const search_notes = tool({
    description:
      "Full-text keyword search over the user's memos, past mentor/therapy sessions, and their whole event timeline — searches, pages visited, videos watched, music, meetings (kind: event). " +
      "Use it for qualitative context (how they described a day, a commitment they made) and for activity lookups ('when did I research X'). Returns short snippets.",
    inputSchema: z.object({
      query: z.string().describe("Keywords, e.g. 'sleep tired' or 'deploy shipped'."),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    execute: async ({ query, limit }) => {
      if (!fs.existsSync(dbFile)) return { matches: [] };
      const match = ftsQuery(query);
      if (!match) return { matches: [] };
      let db;
      try {
        db = openReadonly(dbFile);
        const rows = db
          .prepare(
            `SELECT ref, kind, snippet(search, 2, '[', ']', '…', 12) AS snippet,
                    (SELECT e.date FROM events e WHERE search.kind = 'event' AND e.id = substr(search.ref, 7)) AS date
             FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(match, Math.min(limit ?? 8, 25)) as { ref: string; kind: string; snippet: string; date: string | null }[];
        used.hits += rows.length;
        return { matches: rows };
      } catch (e) {
        return { error: (e as Error).message, matches: [] };
      } finally {
        db?.close();
      }
    },
  });

  const find_similar = tool({
    description:
      "Semantic search over the user's memos, past sessions, and imported daily journal text using the local embedding index - finds days that FELT like a described feeling or situation, even when they don't share the exact words (e.g. 'anxious, couldn't sleep' also surfaces a day they wrote 'wired and stressed'). " +
      "Use this for recall/vibe questions ('find days that felt like this', 'when have I felt this way', 'days like today'). It returns the closest days with a dated snippet. For exact keywords use search_notes; for numbers use query_daily.",
    inputSchema: z.object({
      query: z.string().describe("The feeling or situation to match, in natural language."),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    execute: async ({ query, limit }) => {
      try {
        const vecFile = path.join(path.dirname(dbFile), "agentqs-vec.db");
        const hits = await semanticSearch(query, { vecFile, limit: Math.min(limit ?? 5, 10) });
        used.hits += hits.length;
        for (const h of hits)
          used.sources.add(h.kind === "session" ? "sessions" : h.kind === "daily_text" ? "daily journal text" : "memos");
        return { days: hits.map((h) => ({ date: h.date, snippet: h.snippet, score: h.score })) };
      } catch (e) {
        return { error: (e as Error).message, days: [] };
      }
    },
  });

  const find_similar_images = tool({
    description:
      "Text → image recall over the user's photos using the local CLIP index — finds photos that MATCH a natural-language description ('beach at sunset', 'my dog', 'whiteboard sketches', 'nights out with friends') with no labels and no key. " +
      "Returns the closest photos with their date, caption (if any) and match score. Use it when the user refers to what they photographed or wants you to reason from their pictures.",
    inputSchema: z.object({
      query: z.string().describe("A natural-language description of the photo(s) to find."),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: async ({ query, limit }) => {
      try {
        const hits = await findSimilarImages(query, Math.min(limit ?? 6, 20));
        used.hits += hits.length;
        if (hits.length) used.sources.add("photos");
        return {
          photos: hits.map((h) => ({ date: h.date, caption: h.caption, tags: h.tags, score: h.score })),
        };
      } catch (e) {
        return { error: (e as Error).message, photos: [] };
      }
    },
  });

  const photo_context = tool({
    description:
      "What the user's photos say about a stretch of time around a date — how many photos, whether they were geotagged (out and about vs home), what's in them (captions / scene tags like people, nature, food). " +
      "Use it to enrich a day the user asks about ('what was going on around June 4?') from their pictures.",
    inputSchema: z.object({
      date: z.string().describe("ISO date (YYYY-MM-DD) to center on."),
      windowDays: z.number().int().min(0).max(30).optional().describe("Days either side (default 1)."),
    }),
    execute: async ({ date, windowDays }) => {
      try {
        const ctx = photoContext(date, windowDays ?? 1);
        if (ctx.count) used.sources.add("photos");
        used.hits += ctx.count;
        return {
          count: ctx.count,
          geotagged: ctx.geotagged,
          cameras: ctx.cameras,
          tags: ctx.tags,
          captions: ctx.captions.slice(0, 12),
        };
      } catch (e) {
        return { error: (e as Error).message, count: 0 };
      }
    },
  });

  // ---- Write tools: the conversation feeds the record ("the database builds
  //      itself"). Each append lands in the record + is indexed for search. ------

  const log_memo = tool({
    description:
      "Save a short memo to the record — a fact, an observation, something the user said to remember. Lands in the inbox exactly like a `//` memo and is searchable next time. Use it when the user says 'note that…', 'remember…', or drops a fact worth keeping.",
    inputSchema: z.object({ text: z.string().describe("The memo text to save verbatim.") }),
    execute: async ({ text }) => {
      const t = text.trim();
      if (!t) return { error: "Empty memo." };
      const rDir = recordDir();
      const item = appendInboxItem({ text: t, source: "chat" }, { recordDir: rDir });
      // Parity with `//` memos: auto-structure when the Settings toggle is on
      // (structurePending rebuilds when it merges — rebuild only otherwise).
      const auto = await autoStructureNewItem(item.id);
      if (!auto || auto.structured === 0) rebuild({ recordDir: rDir });
      return { saved: true, structured: (auto?.structured ?? 0) > 0 };
    },
  });

  const save_insight = tool({
    description:
      "Save an insight surfaced in this conversation — a pattern or realisation about the user, in their framing. Kept in the record and searchable. Use it when the exchange produces something worth carrying forward.",
    inputSchema: z.object({ text: z.string().describe("The insight, one sentence.") }),
    execute: async ({ text }) => {
      const t = text.trim();
      if (!t) return { error: "Empty insight." };
      const rDir = recordDir();
      appendInboxItem({ text: t, source: "insight" }, { recordDir: rDir });
      rebuild({ recordDir: rDir });
      return { saved: true };
    },
  });

  const save_commitment = tool({
    description:
      "Save a commitment the user just made — a concrete next action they agreed to. Kept in the record so a later session can hold them to it. Use it only when the user actually commits.",
    inputSchema: z.object({ text: z.string().describe("The commitment, one sentence.") }),
    execute: async ({ text }) => {
      const t = text.trim();
      if (!t) return { error: "Empty commitment." };
      const rDir = recordDir();
      appendInboxItem({ text: t, source: "commitment" }, { recordDir: rDir });
      rebuild({ recordDir: rDir });
      return { saved: true };
    },
  });

  const structure = tool({
    description:
      "Turn pending inbox captures (dropped files, memos with dated metrics) into rows in the daily table. Use it when the user asks to 'structure', 'process the inbox', or 'pull my notes into data'.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const r = await structurePending({ all: true });
        return { ok: r.ok, structured: r.structured, dailyRows: r.dailyRows };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  });

  return {
    query_daily,
    search_notes,
    find_similar,
    find_similar_images,
    photo_context,
    log_memo,
    save_insight,
    save_commitment,
    structure,
  };
}

// ---- Schema catalog (what the model may query) ----------------------------

/** A compact catalog of the daily table so the model knows what's queryable —
 *  the schema + the available (source.metric) series + the date range. This is
 *  metadata, not the values: the numbers themselves come back through the tools. */
export function dailyCatalog(dbFile: string): { sources: string[]; hint: string } {
  if (!fs.existsSync(dbFile)) return { sources: [], hint: "" };
  let db;
  try {
    db = openReadonly(dbFile);
    const pairs = db
      .prepare(
        `SELECT DISTINCT source, metric FROM daily WHERE value_num IS NOT NULL ORDER BY source, metric`,
      )
      .all() as { source: string; metric: string }[];
    if (!pairs.length) return { sources: [], hint: "" };
    const range = db.prepare(`SELECT MIN(date) AS lo, MAX(date) AS hi FROM daily`).get() as {
      lo: string;
      hi: string;
    };
    const sources = [...new Set(pairs.map((p) => p.source))].sort();
    const cols = pairs
      .slice(0, 80)
      .map((p) => `${p.source}.${p.metric}`)
      .join(", ");
    const hint = [
      "DATA — the user's real daily record is a local SQLite table you can query with tools. Never invent numbers; fetch them.",
      "Table `daily` (long/tidy): date TEXT (ISO day), source TEXT, metric TEXT, value_num REAL, value_text TEXT — one row per (date, source, metric).",
      "If the detail store is attached, you can also query `detail.chrome_visits` (ts, domain, category, title, url) and `detail.heart_rate` (datetime, timestamp_ms, hr) — every point behind the daily rollups. Use these for raw browser-visit or per-minute heart-rate questions; use `daily` for day-level trends.",
      `Dates ${range.lo}..${range.hi}. Sources: ${sources.join(", ")}.`,
      `Queryable numeric series (source.metric): ${cols}.`,
      "Call query_daily with a SELECT to pull the exact figures before you answer — SELECT the `source` column so citations are attributed. Call search_notes for keywords in memos / past sessions, or find_similar for semantic recall ('days that felt like this'). For anything about photos, call find_similar_images (text→image recall) or photo_context (what a date's photos show). When explaining how the user feels, line up 2+ sources.",
      "You can also WRITE to the record so the conversation feeds it: log_memo (save a fact/observation), save_insight (a realisation), save_commitment (a concrete next action the user commits to), structure (turn pending inbox items into daily rows). Use them when the user asks to note/remember/log something or commits to an action — the database builds itself.",
    ].join("\n");
    return { sources, hint };
  } finally {
    db?.close();
  }
}

// ---- The agent loop -------------------------------------------------------

export interface MentorRun {
  text: string;
  grounded: boolean; // did a tool return real data?
  sources: string[]; // daily sources the answer drew on
  metrics: string[]; // daily metrics the answer drew on
  toolCalls: number;
  steps: number;
}

export interface RunMentorOptions {
  model: LanguageModel;
  system: string;
  messages: LlmMessage[];
  dbFile: string;
  maxSteps?: number;
  signal?: AbortSignal;
}

/**
 * Run the mentor agent: hand the model the persona + schema catalog as the system
 * prompt and let it call query_daily / search_notes to ground its answer in real
 * numbers, iterating until it has enough to reply. Returns the final text plus what
 * the run actually touched (for the grounded badge).
 */
export async function runMentor(opts: RunMentorOptions): Promise<MentorRun> {
  const used: Used = { sources: new Set(), metrics: new Set(), hits: 0 };
  const tools = mentorTools(opts.dbFile, used);

  const result = await generateText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages as unknown as ModelMessage[],
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 6),
    abortSignal: opts.signal,
  });

  const toolCalls = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  return {
    text: result.text.trim(),
    grounded: used.hits > 0,
    sources: [...used.sources].sort(),
    metrics: [...used.metrics].sort(),
    toolCalls,
    steps: result.steps.length,
  };
}

// ---- Streaming (Loop 5: the Chat UI reads tokens as they arrive) ----------

/** A streaming mentor run: the same tool-using agent as `runMentor`, but the final
 *  reply is streamed token-by-token via `result.textStream`. Tool calls still run to
 *  completion between steps (no text streams during a tool step); `used` fills in as
 *  they execute and is final once `textStream` drains, so the caller can attribute
 *  the grounded badge + sparkline after the stream. `err` captures a mid-stream model
 *  error the SDK would otherwise swallow — check it once the stream ends. */
export function streamMentor(opts: RunMentorOptions): {
  textStream: AsyncIterable<string>;
  used: Used;
  err: { error?: unknown };
} {
  const used: Used = { sources: new Set(), metrics: new Set(), hits: 0 };
  const tools = mentorTools(opts.dbFile, used);
  const err: { error?: unknown } = {};

  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages as unknown as ModelMessage[],
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 6),
    abortSignal: opts.signal,
    onError: (e) => {
      err.error = (e as { error?: unknown }).error ?? e;
    },
  });

  return { textStream: result.textStream, used, err };
}
