import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv } from "@/lib/record";
import { whoopHrDir, WHOOP_RETIRED } from "@/lib/importers/whoop";
import { readSyncRuns } from "@/lib/sync-runs";
import { readSyncJob } from "@/lib/sync-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Point {
  date: string;
  value: number;
}

function whoopCsvPath(): string {
  return path.join(recordDir(), "daily", "whoop.csv");
}

/** Count the per-minute heart-rate samples captured across all day files. */
function countMinutes(): number {
  const dir = whoopHrDir(recordDir());
  let minutes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".csv")) continue;
      const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split(/\r?\n/);
      minutes += Math.max(0, lines.length - 1); // minus header
    }
  } catch {
    /* no HR dir yet */
  }
  return minutes;
}

/** Current WHOOP state, read straight from the record. Never leaks the password. */
function status() {
  const cfg = readConfig();
  const wc = cfg?.whoopCreds;
  const file = whoopCsvPath();
  const out = {
    // connected ⇔ stored credentials (the rule everywhere); data rows are hasData.
    connected: Boolean(wc?.email && (wc?.password || wc?.refreshToken)),
    hasData: false,
    email: wc?.email ?? "",
    hasPassword: Boolean(wc?.password),
    hasCredential: Boolean(wc?.email && (wc?.password || wc?.refreshToken)),
    syncedAt: cfg?.sourceSyncedAt?.whoop ?? null,
    job: readSyncJob("whoop"),
    lastRun: readSyncRuns().runs["whoop"] ?? null,
    days: 0,
    latest: null as number | null,
    average: null as number | null,
    minutes: countMinutes(),
    series: [] as Point[],
  };
  if (!fs.existsSync(file)) return out;
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  const di = header.indexOf("date");
  const mi = header.indexOf("recovery");
  if (di < 0 || rows.length === 0) return out;
  out.hasData = true;
  out.days = rows.filter((r) => (r[di] ?? "").trim() !== "").length;
  if (mi >= 0) {
    const series: Point[] = [];
    for (const r of rows) {
      const date = (r[di] ?? "").trim();
      const n = Number((r[mi] ?? "").trim());
      if (date && Number.isFinite(n)) series.push({ date, value: n });
    }
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (series.length) {
      out.latest = series[series.length - 1].value;
      out.average = Math.round((series.reduce((s, p) => s + p.value, 0) / series.length) * 100) / 100;
      out.series = series.slice(-30);
    }
  }
  return out;
}

export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(status());
}

/**
 * RETIRED UPSTREAM. WHOOP deleted the app-login endpoint this source rode on
 * (api-7.whoop.com no longer resolves), so connecting or syncing can only fail —
 * and the DNS failure reads to the user as a rejected password. The route says so
 * instead of taking a password and pointing it at a host that is gone. The record
 * (GET, above) keeps every minute already imported; the official WHOOP API row is
 * the connect that works.
 */
export async function POST() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json({ error: WHOOP_RETIRED }, { status: 410 });
}
