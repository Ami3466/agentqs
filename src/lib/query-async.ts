import { Worker } from "worker_threads";
import fs from "fs";
import { dbPath, detailPath } from "./paths";
import type { QueryResult } from "./cli-core";

/** Hard ceiling on rows returned to an HTTP/agent caller. A SELECT with no LIMIT is
 *  capped here; a bigger ask is paginated with OFFSET, never streamed as one giant
 *  JSON body that pins the server's memory. */
export const MAX_ROWS = 50_000;

/** Default wall-clock a single query is allowed before it is cancelled. Long enough
 *  for a real cross-source correlation over an indexed range; short enough that a
 *  runaway full-table scan can't hold a slot. */
export const DEFAULT_QUERY_TIMEOUT_MS = 8_000;

/** Validate + cap a caller's SQL. Returns the (optionally LIMIT-appended) SQL AND the
 *  row `cap` — the caller MUST enforce `cap` while reading rows (see `capRows`), never
 *  trust the appended LIMIT alone: "limit" appearing in a subquery/alias/string skips
 *  the append, so the regex is an optimization hint, not the ceiling.
 *
 *  The SELECT/WITH check is a UX filter that rejects an obvious mistake early; it is
 *  NOT what keeps the cache read-only. `WITH … DELETE` starts with "with" and would
 *  pass here — the real guarantee is the connection (readonly + query_only=ON in the
 *  worker and in `openReadonly`), so the write is refused at prepare. Do not relax
 *  those flags on the strength of this regex. Shared by `core.query` (CLI/MCP) and the
 *  async web runner so both doors enforce the same rules. */
export function prepareSql(sql: string, limit = 200): { sql: string; limit: number } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT / WITH queries are allowed.");
  }
  const cap = Math.min(Math.max(1, Math.floor(limit) || 200), MAX_ROWS);
  const capped = /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT ${cap}`;
  return { sql: capped, limit: cap };
}

/** The worker body, run via `new Worker(code, {eval:true})` so there is no separate
 *  file for Next's standalone bundler to miss — it requires the already-present
 *  better-sqlite3 and opens the cache read-only, exactly like `openReadonly`, then
 *  hands the rows back. Because it runs on its OWN thread, the main Node thread stays
 *  free while a heavy scan runs — the whole point: a slow query no longer freezes the
 *  web server, and the parent can time it out and terminate it mid-flight. */
const WORKER_CODE = `
const { parentPort, workerData } = require("worker_threads");
try {
  const Database = require("better-sqlite3");
  const { file, detail, sql, cap } = workerData;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 2000");
  if (detail) {
    try {
      const q = "'" + String(detail).replace(/'/g, "''") + "'";
      db.exec("ATTACH DATABASE " + q + " AS detail");
      db.exec("ATTACH DATABASE " + q + " AS hires");
    } catch (e) { /* main cache is still readable without the detail store */ }
  }
  // Iterate and stop at the cap so a query whose LIMIT the regex missed (a subquery
  // LIMIT, a "limit" alias) still can't materialize a whole table into memory + the
  // JSON body. This is the real ceiling; the appended LIMIT is only a fast path.
  const stmt = db.prepare(sql);
  const rows = [];
  for (const r of stmt.iterate()) {
    rows.push(r);
    if (rows.length >= cap) break;
  }
  const columns = rows.length ? Object.keys(rows[0]) : [];
  db.close();
  parentPort.postMessage({ ok: true, columns, rows, count: rows.length });
} catch (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
}
`;

/**
 * Run a read-only SELECT on a worker thread with a wall-clock timeout.
 *
 * This is the web/agent query path. `core.query` stays synchronous for the CLI and
 * MCP — each is its own short-lived process, so a blocking read only stalls itself.
 * The long-lived web server is different: better-sqlite3 is synchronous, so a single
 * unindexed scan on a million-row `events`/`detail` table froze EVERY concurrent
 * request for the seconds it ran (db.ts documents a 2.3s scan that "froze the whole
 * Node thread"). Off-loading to a worker keeps the request thread responsive and lets
 * a genuinely runaway query be cancelled instead of wedging the box.
 */
export async function runQueryAsync(
  sql: string,
  limit = 200,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<QueryResult> {
  const { sql: capped, limit: cap } = prepareSql(sql, limit);
  const file = dbPath();
  if (!fs.existsSync(file)) throw new Error("No cache yet — run `agentqs rebuild` first.");
  const store = detailPath();
  const detail = fs.existsSync(store) ? store : null;

  return await new Promise<QueryResult>((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { file, detail, sql: capped, cap } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Query exceeded ${Math.round(timeoutMs / 1000)}s and was cancelled. ` +
              `Narrow it with a WHERE/date filter or a smaller LIMIT.`,
          ),
        ),
      );
    }, timeoutMs);
    worker.once("message", (msg: { ok?: boolean; columns?: string[]; rows?: Record<string, unknown>[]; count?: number; error?: string }) => {
      finish(() =>
        msg?.ok
          ? resolve({ columns: msg.columns ?? [], rows: msg.rows ?? [], count: msg.count ?? 0 })
          : reject(new Error(msg?.error || "Query failed.")),
      );
    });
    worker.once("error", (e) => finish(() => reject(e)));
  });
}

/** The core tables, documented — an agent reads this instead of guessing column names.
 *  `daily` is the trap: it's LONG format, so metric names are VALUES in a column, not
 *  columns. Every "no such column: recovery" mistake comes from missing that. */
const SCHEMA_TABLES = [
  {
    name: "daily",
    columns: ["date", "source", "metric", "value_num", "value_text"],
    grain:
      "LONG format — one row per (date, source, metric). Metric names (recovery, steps, …) are VALUES in the `metric` column, NOT columns. Read one metric with WHERE metric='recovery'; combine several by pivoting (see recipes).",
  },
  { name: "events", columns: ["date", "source", "kind", "detail", "value_num"], grain: "Raw timeline events, one row each." },
  { name: "sessions", columns: ["id", "date", "kind", "summary", "commitments"], grain: "Chat/therapy sessions with synthesized insight." },
  { name: "raw_inbox", columns: ["id", "ts", "text", "status"], grain: "Captured notes before they're structured." },
  { name: "search", columns: ["date", "source", "text"], grain: "FTS index over the record's free text (use MATCH)." },
];

/** Copy-paste query shapes — the difference between an agent that flails and one that
 *  gets it right on the first call. */
const QUERY_RECIPES = [
  { what: "one metric over time", sql: "SELECT date, value_num FROM daily WHERE metric='recovery' ORDER BY date DESC" },
  {
    what: "several metrics side by side (pivot)",
    sql: "SELECT date, MAX(CASE WHEN metric='recovery' THEN value_num END) AS recovery, MAX(CASE WHEN metric='steps' THEN value_num END) AS steps FROM daily GROUP BY date ORDER BY date DESC",
  },
  {
    what: "correlate two metrics on shared days",
    sql: "SELECT a.date, a.value_num AS recovery, b.value_num AS steps FROM daily a JOIN daily b ON a.date=b.date WHERE a.metric='recovery' AND b.metric='steps' ORDER BY a.date DESC",
  },
  { what: "what metrics exist", sql: "SELECT metric, source, COUNT(*) AS days FROM daily GROUP BY metric, source ORDER BY days DESC" },
];

export interface SchemaDescription {
  grain: string;
  tables: typeof SCHEMA_TABLES;
  metrics: Record<string, unknown>[];
  sources: string[];
  dateRange: Record<string, unknown> | null;
  recipes: typeof QUERY_RECIPES;
}

/**
 * Self-describe the queryable record — the schema plus the LIVE metric catalog (every
 * metric, its source, day-count and date span). This is what makes the HTTP query door
 * as usable as the local CLI: an agent GETs this first and knows exactly what to ask,
 * instead of guessing `recovery/happiness/fire` as columns and hitting errors.
 */
export async function describeSchema(): Promise<SchemaDescription> {
  const safe = (sql: string, limit = 1000) =>
    runQueryAsync(sql, limit).catch(() => ({ columns: [], rows: [], count: 0 }) as QueryResult);
  const metricsRes = await safe(
    "SELECT metric, source, COUNT(*) AS days, MIN(date) AS first_date, MAX(date) AS last_date FROM daily GROUP BY metric, source ORDER BY days DESC",
  );
  const rangeRes = await safe(
    "SELECT MIN(date) AS first_date, MAX(date) AS last_date, COUNT(DISTINCT date) AS days FROM daily",
  );
  const sources = [...new Set(metricsRes.rows.map((r) => String(r.source)))].sort();
  return {
    grain: SCHEMA_TABLES[0].grain,
    tables: SCHEMA_TABLES,
    metrics: metricsRes.rows,
    sources,
    dateRange: rangeRes.rows[0] ?? null,
    recipes: QUERY_RECIPES,
  };
}

/** Turn a raw SQLite error into agent-actionable guidance. The classic failure — a
 *  wide-column guess against the long `daily` table — becomes a pointer to the right
 *  shape and the schema door, instead of a dead end. */
export function explainQueryError(message: string): string {
  if (/no such column/i.test(message)) {
    return (
      `${message} — NOTE: \`daily\` is long-format (columns: date, source, metric, value_num, value_text). ` +
      `Metric names are VALUES in \`metric\`, not columns: use WHERE metric='<name>'. ` +
      `GET /api/query for the live metric catalog + query recipes.`
    );
  }
  if (/no such table/i.test(message)) {
    return `${message} — tables: daily, events, sessions, raw_inbox, search (+ detail.* when present). GET /api/query for the schema.`;
  }
  return message;
}
