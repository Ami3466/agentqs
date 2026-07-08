import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-day view of the rebuilt cache — metrics pivoted to columns, plus the
 * memos and sessions on each day. Powers the Journal Timeline + Table.
 *   ?days=N     window of the N most recent days with data (default 180)
 *   ?days=all   full history (the Journal's "Load full history")
 *   ?days=0     metadata only (metrics + totals, no day values)
 *   ?numeric=1  blank cell text — the Graphs payload, which only reads numbers */
export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  const rawDays = url.searchParams.get("days");
  const days =
    rawDays === "all"
      ? ("all" as const)
      : rawDays != null && Number.isFinite(Number(rawDays))
        ? Number(rawDays)
        : 180;
  const numericOnly = url.searchParams.get("numeric") === "1";
  return NextResponse.json(readJournal({ days, numericOnly }));
}
