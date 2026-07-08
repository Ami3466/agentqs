import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { applyDailyEdits, rebuild, type DailyEdit } from "@/lib/record";
import { readJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EDITS = 10_000;

function asEdit(raw: unknown): DailyEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (o.op === "set" && s("source") && s("metric") && s("date")) {
    return { op: "set", source: s("source"), metric: s("metric"), date: s("date"), value: s("value") };
  }
  if (o.op === "deleteColumn" && s("source") && s("metric")) {
    return { op: "deleteColumn", source: s("source"), metric: s("metric") };
  }
  if (o.op === "deleteRow" && s("date")) {
    return { op: "deleteRow", date: s("date") };
  }
  return null;
}

/** Batch-edit the daily record from the Journal table's Edit mode: set/clear
 * cells, delete columns, delete rows. Writes record/daily/*.csv (the source of
 * truth), rebuilds the cache, and returns the fresh journal so the table can
 * swap its data without a second fetch. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { edits?: unknown[] };
  const raw = Array.isArray(body.edits) ? body.edits : [];
  const edits = raw.map(asEdit).filter((e): e is DailyEdit => e !== null);
  if (!edits.length) {
    return NextResponse.json({ error: "No valid edits." }, { status: 400 });
  }
  if (edits.length > MAX_EDITS) {
    return NextResponse.json({ error: `Too many edits (max ${MAX_EDITS}).` }, { status: 400 });
  }

  const result = applyDailyEdits(edits, { recordDir: recordDir() });
  rebuild({ recordDir: recordDir() });

  return NextResponse.json({ ok: true, ...result, journal: readJournal({ days: 180 }) });
}
