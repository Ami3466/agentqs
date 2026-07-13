import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv } from "@/lib/record";
import {
  ensureSession,
  isWhoopInstance,
  mergeTokens,
  setWhoopCreds,
  whoopCredsFor,
  whoopHrDir,
  whoopLogin,
  type WhoopCreds,
} from "@/lib/importers/whoop";
import { whoopInstanceName } from "@/lib/cli-core";
import { readSyncRuns } from "@/lib/sync-runs";
import { readSyncJob, startSyncJob } from "@/lib/sync-jobs";
import { wipeDemoOnImport } from "@/lib/demo";
import { syncSource } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Point {
  date: string;
  value: number;
}

/** The WHOOP account this request is for — base "whoop" or an extra "whoop-2". */
function instanceOf(req: Request): string {
  const id = new URL(req.url).searchParams.get("instance")?.trim() || "whoop";
  return isWhoopInstance(id) ? id : "whoop";
}

function whoopCsvPath(instanceId: string): string {
  return path.join(recordDir(), "daily", `${instanceId}.csv`);
}

/** Count the per-minute heart-rate samples captured across all day files. */
function countMinutes(instanceId: string): number {
  const dir = whoopHrDir(recordDir(), instanceId);
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
function status(instanceId: string) {
  const cfg = readConfig();
  const wc = whoopCredsFor(cfg, instanceId);
  const file = whoopCsvPath(instanceId);
  const out = {
    id: instanceId,
    // connected ⇔ stored credentials (the rule everywhere); data rows are hasData.
    connected: Boolean(wc?.email && (wc?.password || wc?.refreshToken)),
    hasData: false,
    email: wc?.email ?? "",
    hasPassword: Boolean(wc?.password),
    hasCredential: Boolean(wc?.email && (wc?.password || wc?.refreshToken)),
    syncedAt: cfg?.sourceSyncedAt?.[instanceId] ?? null,
    job: readSyncJob(instanceId),
    lastRun: readSyncRuns().runs[instanceId] ?? null,
    days: 0,
    latest: null as number | null,
    average: null as number | null,
    minutes: countMinutes(instanceId),
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

export async function GET(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(status(instanceOf(req)));
}

/**
 * Connect (email + password) and/or sync WHOOP via the unofficial app login.
 * Fresh credentials are TESTED with a real login first — only working ones are
 * stored (with the minted tokens), so scheduled pulls keep working. The sync
 * itself runs as a background job (202) that survives page refreshes.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const instanceId = instanceOf(req);
  const name = whoopInstanceName(instanceId);
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    days?: number;
    hrDays?: number;
    /** Pull the account's ENTIRE history (a first import does this on its own). */
    allTime?: boolean;
    test?: boolean;
  };
  const cfg = readConfig();
  if (!cfg) return NextResponse.json({ error: "Not set up." }, { status: 400 });

  const stored = whoopCredsFor(cfg, instanceId) ?? ({} as WhoopCreds);
  const email = (body.email ?? stored.email ?? "").trim();
  const password = (body.password ?? stored.password ?? "").trim();
  if (!email || !(password || stored.refreshToken)) {
    return NextResponse.json(
      { error: "Add your WHOOP email + password to connect." },
      { status: 400 },
    );
  }

  // Fresh email/password → prove the login BEFORE storing anything. The minted
  // tokens are kept so the first sync doesn't have to log in twice.
  const freshCreds = Boolean(body.email || body.password);
  if (freshCreds || body.test === true) {
    try {
      if (body.test === true && !password) {
        // Nothing to password-test: prove the STORED grant the way a sync
        // would (refresh path — the same verdict as `agentqs source test
        // whoop`), and persist the rotated tokens.
        const s = await ensureSession(stored);
        setWhoopCreds(cfg, instanceId, s.creds);
        writeConfig(cfg);
        return NextResponse.json({ id: instanceId, name, ok: true, detail: `logged in as ${email}` });
      }
      const session = await whoopLogin(email, password);
      if (body.test === true) {
        return NextResponse.json({ id: instanceId, name, ok: true, detail: `logged in as ${email}` });
      }
      setWhoopCreds(cfg, instanceId, mergeTokens({ ...stored, email, password }, session));
      writeConfig(cfg);
    } catch (e) {
      return NextResponse.json({ error: `WHOOP login failed — ${(e as Error).message}` }, { status: 400 });
    }
  }

  wipeDemoOnImport(); // first real import clears the generic demo record

  const days = body.days && body.days > 0 ? body.days : undefined;
  const hrDays = body.hrDays && body.hrDays > 0 ? body.hrDays : undefined;
  const allTime = body.allTime === true;
  const job = startSyncJob(instanceId, async (progress) => {
    const r = await syncSource({ id: instanceId, days, hrDays, allTime, onProgress: progress });
    return { days: r.days, dailyRows: r.dailyRows };
  });

  return NextResponse.json({ ok: true, id: instanceId, name, job }, { status: 202 });
}
