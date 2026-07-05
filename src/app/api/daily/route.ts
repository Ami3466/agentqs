import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readDailySummary } from "@/lib/daily";
import { recordDir } from "@/lib/paths";
import { mergeDailyCsv, rebuild } from "@/lib/record";
import {
  SELF_DIMENSIONS,
  SELF_SOURCE,
  isIsoDate,
  validRating,
} from "@/lib/self-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only summary of the rebuilt daily cache — powers the Data-tab preview. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(readDailySummary());
}

/**
 * Save a daily self-rating check-in. Body: `{ date, ratings: { mood, energy,
 * focus, sleep } }` (values 1–10; any subset allowed). Writes one numeric column
 * per dimension into record/daily/self.csv via the same mergeDailyCsv → rebuild
 * path the importers use, so the numbers land in the daily table and Journal like
 * any other source.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    date?: unknown;
    ratings?: Record<string, unknown>;
  } & Record<string, unknown>;

  const date = isIsoDate(body.date)
    ? body.date
    : new Date().toISOString().slice(0, 10);

  // Accept ratings under `ratings` or as top-level dimension keys.
  const src = (body.ratings && typeof body.ratings === "object" ? body.ratings : body) as Record<
    string,
    unknown
  >;

  const header: string[] = ["date"];
  const cell: string[] = [date];
  const saved: Record<string, number> = {};
  for (const dim of SELF_DIMENSIONS) {
    if (!(dim.key in src) || src[dim.key] === "" || src[dim.key] == null) continue;
    const n = validRating(src[dim.key]);
    if (n == null) {
      return NextResponse.json(
        { error: `${dim.label} must be a whole number from 1 to 10.` },
        { status: 400 },
      );
    }
    header.push(dim.key);
    cell.push(String(n));
    saved[dim.key] = n;
  }

  if (header.length === 1) {
    return NextResponse.json(
      { error: "Rate at least one dimension (1–10)." },
      { status: 400 },
    );
  }

  const rDir = recordDir();
  mergeDailyCsv(rDir, SELF_SOURCE, { header, rows: [cell] });
  rebuild({ recordDir: rDir });

  return NextResponse.json({
    ok: true,
    date,
    source: SELF_SOURCE,
    saved,
    summary: readDailySummary(),
  });
}
