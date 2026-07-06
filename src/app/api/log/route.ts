import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { readInboxFromRecord } from "@/lib/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 200;
const PREVIEW_CHARS = 4_000;
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
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const inbox = readInboxFromRecord(recordDir());
  const items = inbox
    .slice(-LIMIT)
    .reverse()
    .map((i) => {
      const meta = (i.meta && typeof i.meta === "object" ? i.meta : {}) as LogMeta;
      const applied = Array.isArray(meta.applied) ? meta.applied : [];
      // The reviewable diff: date/metric cells this item changed, before → after.
      // Items structured before `v` was recorded fall back to the counts line.
      const revertableCount = applied.filter((c) => c && typeof c === "object" && typeof (c as { v?: unknown }).v === "string").length;
      const cells = applied.slice(0, APPLIED_PREVIEW).flatMap((c) => {
        if (!c || typeof c !== "object") return [];
        const { d, m, p, v } = c as { d?: unknown; m?: unknown; p?: unknown; v?: unknown };
        if (typeof d !== "string" || typeof m !== "string" || typeof v !== "string") return [];
        return [{ d, m, before: typeof p === "string" ? p : null, after: v }];
      });
      return {
        id: i.id,
        ts: i.ts,
        source: i.source,
        kind: i.kind,
        status: i.status,
        text: i.text.slice(0, PREVIEW_CHARS),
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
                applied: cells,
              }
            : null,
        rejectedAt: typeof meta.rejectedAt === "string" ? meta.rejectedAt : null,
      };
    });
  return NextResponse.json({ total: inbox.length, items });
}
