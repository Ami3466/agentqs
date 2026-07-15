import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError } from "@/lib/api";
import { runQueryAsync, MAX_ROWS } from "@/lib/query-async";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only SQL over the rebuilt cache — the same door as `agentqs query` and the
 * MCP `query` tool, now reachable over HTTP so an agent driving the API has the full
 * analytical surface (arbitrary date ranges, multi-metric joins, raw rows), not just
 * the grounded chat reply.
 *
 * Tables: daily(date, source, metric, value_num, value_text), raw_inbox, sessions,
 * events, search (FTS); when a detail store exists it is attached as `detail`
 * (per-minute detail.heart_rate, per-visit detail.chrome_visits).
 *
 * SELECT / WITH only. Runs on a worker thread with a wall-clock timeout, so a heavy
 * or runaway query is cancelled instead of freezing the web server.
 *
 *   POST /api/query  {"sql":"SELECT ...", "limit":500, "timeoutMs":8000}
 *   -> {columns, rows, count}
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    sql?: string;
    limit?: number;
    timeoutMs?: number;
  };
  const sql = (body.sql ?? "").trim();
  if (!sql) return NextResponse.json({ error: "Provide a `sql` SELECT." }, { status: 400 });

  const limit = Number.isFinite(body.limit) ? Number(body.limit) : 200;
  // Cap the caller's timeout so no single request can hold a worker indefinitely.
  const timeoutMs = Number.isFinite(body.timeoutMs)
    ? Math.min(Math.max(1_000, Number(body.timeoutMs)), 30_000)
    : undefined;

  try {
    const result = await runQueryAsync(sql, limit, timeoutMs);
    return NextResponse.json({ ...result, maxRows: MAX_ROWS });
  } catch (e) {
    // Bad SQL / rejected statement is the caller's fault (400); everything else 500.
    const msg = e instanceof Error ? e.message : String(e);
    const isUserError =
      /^Only read-only|LIMIT|no such|syntax error|unrecognized|near |ambiguous|has no column|exceeded \d+s/i.test(msg);
    return apiError(e, isUserError ? 400 : 500);
  }
}
