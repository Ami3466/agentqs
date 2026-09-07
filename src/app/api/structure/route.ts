import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readSyncJob, startJobAndWait, STRUCTURE_JOB } from "@/lib/sync-jobs";
import { structurePending } from "@/lib/structure-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drain pending inbox items into the daily table via the shared Structure core
 * (clean CSV → direct column map, prose → LLM). One implementation backs this
 * route, the `agentqs structure` CLI, and the MCP tool.
 *
 * Body: `{ id }` structures one pending item; `{}` / `{ all: true }` drains all;
 * `{ id, csv }` is the key-free agent route — the caller did the reasoning and
 * hands the exact `date,...` CSV to merge (same contract as the CLI/MCP tool).
 *
 * THE WORK RUNS AS A BACKGROUND JOB, on the same serial queue imports use. This
 * request is the one that froze production: structuring five items held every
 * request on the instance for over fifteen minutes, because better-sqlite3 is
 * synchronous and the record mutation ran inline on the request thread. A fast
 * structure still answers in one round trip with its full result; a slow one hands
 * back 202 + the job and the UI follows it exactly like an import.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean; csv?: string };
  const { job, result, error } = await startJobAndWait(STRUCTURE_JOB, async () => {
    const r = await structurePending({ id: body.id, all: body.all, csv: body.csv }); // wipes demo itself
    // A refusal ("that item isn't pending", "the CSV loses data") is an error for
    // the job row too — a run that structured nothing must never read as done.
    if (!r.ok) throw new Error(r.error || "Structuring failed.");
    return { result: r, summary: { dailyRows: r.dailyRows ?? undefined } };
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.message.includes("isn't in") ? 404 : 400 });
  }
  if (!result) {
    // Still running. The capture is untouched on disk and the queue owns the work.
    return NextResponse.json({ ok: true, queued: true, job }, { status: 202 });
  }
  return NextResponse.json({
    ok: true,
    structured: result.structured,
    results: result.results,
    pending: result.pending,
    dailyRows: result.dailyRows,
    scan: result.scan,
    job,
  });
}

/** The structure job's live state — what the UI polls after a 202. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json({ job: readSyncJob(STRUCTURE_JOB) });
}
