import fs from "fs";
import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { openReadonly } from "./db";
import { fallbackModel } from "./models";
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

/** Resolve a BYO-key provider + model into a Vercel AI SDK LanguageModel. */
export function resolveModel(provider: string, apiKey: string, model?: string | null): LanguageModel {
  const id = fallbackModel(provider, model);
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(id);
    case "openai":
      return createOpenAI({ apiKey })(id);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(id);
    default:
      throw new Error(`Unknown provider "${provider}".`);
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

interface Used {
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
      "Full-text keyword search over the user's memos and past mentor/therapy sessions (their own words — not the daily numbers). " +
      "Use it for qualitative context: how they described a day, a commitment they made, a recurring theme. Returns short snippets.",
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
            `SELECT ref, kind, snippet(search, 2, '[', ']', '…', 12) AS snippet
             FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(match, Math.min(limit ?? 8, 25)) as { ref: string; kind: string; snippet: string }[];
        used.hits += rows.length;
        return { matches: rows };
      } catch (e) {
        return { error: (e as Error).message, matches: [] };
      } finally {
        db?.close();
      }
    },
  });

  return { query_daily, search_notes };
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
      `Dates ${range.lo}..${range.hi}. Sources: ${sources.join(", ")}.`,
      `Queryable numeric series (source.metric): ${cols}.`,
      "Call query_daily with a SELECT to pull the exact figures before you answer — SELECT the `source` column so your citations are attributed. Call search_notes for keywords in memos / past sessions. When explaining how the user feels, line up 2+ sources.",
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
