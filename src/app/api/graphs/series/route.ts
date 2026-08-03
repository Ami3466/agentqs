import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { apiError, cachedJson } from "@/lib/api";
import { readGraphSeries } from "@/lib/graphs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/graphs/series — every plottable line in the record: one shared date
 * axis, then each numeric daily metric (sparse) and each per-day count (dense).
 *
 * This exists because the Graphs tab used to answer the same question with the
 * whole journal — 15 MB of cell text, memos, sessions and event counts it never
 * read. That is past the size Chrome will file in its HTTP cache, so the fetch
 * came back `net::ERR_CACHE_WRITE_FAILURE` and the tab was left on its skeleton.
 * Numbers over time is all a graph is; this sends that and nothing else.
 */
export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const url = new URL(req.url);
  // ?catalog=1 → keys + labels, no numbers (what the picker needs).
  // ?keys=a,b  → numbers for just those lines (what a chart needs).
  // Neither → every line, the original behaviour, kept so an older client still works.
  const catalogOnly = url.searchParams.get("catalog") === "1";
  const keys = (url.searchParams.get("keys") || "").split(",").map((k) => k.trim()).filter(Boolean);
  try {
    return cachedJson(req, () => readGraphSeries({ keys, catalogOnly }), [
      catalogOnly ? "catalog" : keys.join(","),
      new Date().toISOString().slice(0, 10),
    ]);
  } catch (e) {
    return apiError(e);
  }
}
