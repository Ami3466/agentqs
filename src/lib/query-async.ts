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
