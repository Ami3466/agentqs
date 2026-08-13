import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { cachedJson } from "@/lib/api";
import { fileStamp } from "@/lib/cache-stamp";
import { recordDir } from "@/lib/paths";
import { readInboxFromRecord } from "@/lib/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 200;
/** The list shows ONE line per row (`text.split("\n",1)[0]`), so that is what the
 *  list payload carries. It used to send 4,000 characters of every capture plus a
 *  hundred cell diffs each — half a megabyte to render 200 single-line rows, all of
 *  it thrown away by the renderer. */
const LIST_PREVIEW_CHARS = 200;
/** What an EXPANDED row shows: the raw capture in a scrollable pre. */
const DETAIL_CHARS = 20_000;
const APPLIED_PREVIEW = 100;

interface LogMeta {
  filename?: unknown;
  source?: unknown;
  via?: unknown;
  cells?: unknown;
  metrics?: unknown;
  structuredAt?: unknown;
  rejectedAt?: unknown;
  applied?: unknown;
}

/** The Data-tab Log: every capture that entered the record — dropped files,
 * memos, photos — newest first, with what Structure made of each one. Read
 * straight from record/inbox.jsonl (the source of truth), all statuses. */
export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const stamp = fileStamp(path.join(recordDir(), "inbox.jsonl"));
  // ?id=<id> — one capture in full, for the row the user just opened. Detail is
  // fetched when it is actually looked at rather than shipped for all 200 rows.
  const id = new URL(req.url).searchParams.get("id");
  if (id) return cachedJson(req, () => buildLogDetail(id), [stamp, id]);
  // Read straight from inbox.jsonl, so THAT file — not the derived cache — is what
  // versions this view: an unchanged inbox answers 304 without reading it.
  return cachedJson(req, buildLog, [stamp]);
}

/** One capture in full: the raw text and the reviewable cell diff. */
function buildLogDetail(id: string) {
  const item = readInboxFromRecord(recordDir()).find((i) => i.id === id);
  // An id that is gone (rejected away, a stale open row) is an EMPTY detail, not an
  // error: the row keeps its list preview instead of the panel showing a failure.
  if (!item) return { id, text: "", textLength: 0, applied: [] as AppliedCell[], appliedTruncated: false };
  const meta = (item.meta && typeof item.meta === "object" ? item.meta : {}) as LogMeta;
  const applied = Array.isArray(meta.applied) ? meta.applied : [];
  return {
    id,
    text: item.text.slice(0, DETAIL_CHARS),
    textLength: item.text.length,
    applied: appliedCells(applied),
    appliedTruncated: applied.length > APPLIED_PREVIEW,
  };
}

interface AppliedCell {
  d: string;
  m: string;
  before: string | null;
  after: string;
}

/** The reviewable diff: date/metric cells this item changed, before → after. */
function appliedCells(applied: unknown[]): AppliedCell[] {
  return applied.slice(0, APPLIED_PREVIEW).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const { d, m, p, v } = c as { d?: unknown; m?: unknown; p?: unknown; v?: unknown };
    if (typeof d !== "string" || typeof m !== "string" || typeof v !== "string") return [];
    return [{ d, m, before: typeof p === "string" ? p : null, after: v }];
  });
}

function buildLog() {
  const inbox = readInboxFromRecord(recordDir());
  const items = inbox
    .slice(-LIMIT)
    .reverse()
    .map((i) => {
      const meta = (i.meta && typeof i.meta === "object" ? i.meta : {}) as LogMeta;
      const applied = Array.isArray(meta.applied) ? meta.applied : [];
      // Items structured before `v` was recorded fall back to the counts line.
      const revertableCount = applied.filter((c) => c && typeof c === "object" && typeof (c as { v?: unknown }).v === "string").length;
      return {
        id: i.id,
        ts: i.ts,
        source: i.source,
        kind: i.kind,
        status: i.status,
        text: i.text.slice(0, LIST_PREVIEW_CHARS),
        textLength: i.text.length,
        filename: typeof meta.filename === "string" ? meta.filename : null,
        structured:
          i.status === "structured"
            ? {
                source: typeof meta.source === "string" ? meta.source : null,
                via: typeof meta.via === "string" ? meta.via : null,
                cells: typeof meta.cells === "number" ? meta.cells : null,
                metrics: Array.isArray(meta.metrics) ? meta.metrics.map(String) : [],
                at: typeof meta.structuredAt === "string" ? meta.structuredAt : null,
                canRevert: revertableCount > 0,
                appliedCount: applied.length,
                appliedTruncated: applied.length > APPLIED_PREVIEW,
              }
            : null,
        rejectedAt: typeof meta.rejectedAt === "string" ? meta.rejectedAt : null,
      };
    });
  return { total: inbox.length, items };
}
