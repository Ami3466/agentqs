import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv, rebuild } from "@/lib/record";
import { windowDays } from "@/lib/importers/plugin";
import { importWhoop, whoopHrDir, type WhoopCreds } from "@/lib/importers/whoop";
import { wipeDemoOnImport } from "@/lib/demo";

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
    connected: false,
    email: wc?.email ?? "",
    hasPassword: Boolean(wc?.password),
    hasCredential: Boolean(wc?.email && (wc?.password || wc?.refreshToken)),
    syncedAt: cfg?.sourceSyncedAt?.whoop ?? null,
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
  out.connected = true;
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
 * Connect (email + password) and/or sync WHOOP via the unofficial app login.
 * A fresh email/password is stored (with the rotated tokens) so scheduled pulls
 * keep working; a re-sync with no body re-uses the stored creds.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    days?: number;
    hrDays?: number;
  };
  const cfg = readConfig();
  if (!cfg) return NextResponse.json({ error: "Not set up." }, { status: 400 });

  const stored = cfg.whoopCreds ?? ({} as WhoopCreds);
  const email = (body.email ?? stored.email ?? "").trim();
  const password = (body.password ?? stored.password ?? "").trim();
  const canAuth = Boolean(email && (password || stored.refreshToken));
  if (!canAuth) {
    return NextResponse.json(
      { error: "Add your WHOOP email + password to connect." },
      { status: 400 },
    );
  }

  const creds: WhoopCreds = { ...stored, email, password: password || stored.password };
  const { from, to } = windowDays(body.days && body.days > 0 ? body.days : 90);

  wipeDemoOnImport(); // first real import clears the generic demo record

  let summary;
  try {
    summary = await importWhoop({
      creds,
      from,
      to,
      recordDir: recordDir(),
      hrDays: body.hrDays && body.hrDays > 0 ? body.hrDays : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Persist the creds with rotated tokens + the sync time so status survives reloads.
  cfg.whoopCreds = summary.creds;
  cfg.sourceSyncedAt = { ...(cfg.sourceSyncedAt ?? {}), whoop: new Date().toISOString() };
  try {
    writeConfig(cfg);
  } catch {
    /* non-fatal: the record already holds the data */
  }

  const r = rebuild({ recordDir: recordDir() });

  return NextResponse.json({
    ok: true,
    id: "whoop",
    name: "WHOOP",
    from: summary.from,
    to: summary.to,
    days: summary.daysWithData,
    metrics: summary.metrics,
    cells: summary.cells,
    minutes: summary.minutes,
    hrDays: summary.hrDays,
    dailyRows: r.daily,
    syncedAt: cfg.sourceSyncedAt.whoop,
  });
}
