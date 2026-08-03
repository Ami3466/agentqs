import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError, cachedJson } from "@/lib/api";
import { readJournal } from "@/lib/journal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-day view of the rebuilt cache — metrics pivoted to columns, plus the
 * memos and sessions on each day. Powers the Journal Timeline + Table.
 *   ?days=N     window of the N most recent days with data (default 180)
 *   ?days=all   full history (the Journal's "Load full history")
 *   ?days=0     metadata only (metrics + totals, no day values)
 *   ?before=D   only days older than D — the paging cursor (response carries
 *               `oldest` to pass back, and `hasMore`)
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
  // Page cursor: days strictly older than this. The Journal asks for a screenful,
  // then asks again from the oldest date it holds — instead of `days=all`, which
  // serialized the whole grid (40MB on a million-cell record) to show fifty rows.
  const before = url.searchParams.get("before") || undefined;
  try {
    // The heaviest read in the app (full history is megabytes). The ETag makes a
    // revisit a bodiless 304 that never even builds the payload.
    return cachedJson(req, () => readJournal({ days, numericOnly, before }), [
      String(days),
      before ?? "",
      numericOnly,
      new Date().toISOString().slice(0, 10),
    ]);
  } catch (e) {
    return apiError(e);
  }
}
