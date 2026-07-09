import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv } from "@/lib/record";
import { extensionLatestVersion, extensionPingFile, extensionSourceDir, GOOGLE_PRESETS } from "@/lib/google-web-scraper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DailyStatus {
  source: string;
  exists: boolean;
  days: number;
  from: string | null;
  to: string | null;
  events: number;
  updatedAt: string | null;
}

// The Data tab polls this route while the Automated tab is open; parsing all
// preset CSVs on every poll would re-read identical files 12x/minute, so each
// file's parsed status is cached against its mtime+size.
const statusCache = new Map<string, { mtimeMs: number; size: number; status: DailyStatus }>();

function dailyStatus(source: string): DailyStatus {
  const file = path.join(recordDir(), "daily", `${source}.csv`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    statusCache.delete(file);
    return { source, exists: false, days: 0, from: null, to: null, events: 0, updatedAt: null };
  }
  const cached = statusCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.status;
  try {
    const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
    const dates = rows.map((row) => row[0]).filter(Boolean).sort();
    const eventsIdx = header.indexOf("events");
    const events = eventsIdx >= 0
      ? rows.reduce((sum, row) => sum + (Number(row[eventsIdx]) || 0), 0)
      : 0;
    const status: DailyStatus = {
      source,
      exists: true,
      days: new Set(dates).size,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      events,
      updatedAt: stat.mtime.toISOString(),
    };
    statusCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, status });
    return status;
  } catch {
    return { source, exists: false, days: 0, from: null, to: null, events: 0, updatedAt: null };
  }
}

function extensionSeenAt(): { seenAt: string | null; version: string } {
  try {
    const raw = JSON.parse(fs.readFileSync(extensionPingFile(), "utf8")) as { seenAt?: unknown; version?: unknown };
    return {
      seenAt: typeof raw.seenAt === "string" ? raw.seenAt : null,
      version: typeof raw.version === "string" ? raw.version : "",
    };
  } catch {
    return { seenAt: null, version: "" };
  }
}

/** Per-preset import coverage for the Data-tab "Google data" card. The preset
 *  list itself comes from GOOGLE_PRESETS — one canonical definition. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const imports = GOOGLE_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    detail: p.detail,
    source: p.dailySource,
    page: p.url,
    retired: p.retired ?? null,
    status: dailyStatus(p.dailySource),
  }));
  const ping = extensionSeenAt();
  return NextResponse.json({
    extensionDir: extensionSourceDir(),
    downloadUrl: "/downloads/agentqs-google-activity-exporter.zip",
    extensionSeenAt: ping.seenAt,
    extensionVersion: ping.version,
    // Unpacked extensions never auto-update; the Data tab compares this to the
    // pinged version and walks the user through replacing + reloading.
    latestVersion: extensionLatestVersion(),
    imports,
  });
}
