import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import {
  importGithub,
  parseGithubCsv,
  resolveGithubToken,
  windowDays,
} from "@/lib/importers/github";
import { rebuild } from "@/lib/record";
import { wipeDemoOnImport } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function githubCsvPath(): string {
  return path.join(recordDir(), "daily", "github.csv");
}

/** Current state of the GitHub source, read straight from the record. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  const file = githubCsvPath();
  const days = fs.existsSync(file) ? parseGithubCsv(fs.readFileSync(file, "utf8")) : [];
  // connected ⇔ a stored token (the rule everywhere) — commit rows in the
  // record are hasData, which must never present the source as connected.
  return NextResponse.json({
    connected: Boolean(resolveGithubToken()),
    hasData: days.length > 0,
    hasToken: Boolean(resolveGithubToken()),
    syncedAt: cfg?.githubSyncedAt ?? null,
    total: days.reduce((n, d) => n + d.commits, 0),
    series: days.slice(-30),
  });
}

/** Run the importer, persist the token if newly given, rebuild the cache. */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    token?: string;
    login?: string;
    days?: number;
  };

  const token = resolveGithubToken(body.token);
  if (!token && !body.login) {
    return NextResponse.json(
      { error: "Add a GitHub token (or set GITHUB_TOKEN) to sync commits." },
      { status: 400 },
    );
  }

  const { from, to } = windowDays(body.days && body.days > 0 ? body.days : 90);

  wipeDemoOnImport(); // first real import clears the generic demo record

  let summary;
  try {
    summary = await importGithub({ token, login: body.login, from, to, recordDir: recordDir() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Persist a freshly supplied token + the sync time so status survives reloads.
  const cfg = readConfig();
  if (cfg) {
    if (body.token && body.token.trim()) cfg.githubToken = body.token.trim();
    cfg.githubSyncedAt = new Date().toISOString();
    try {
      writeConfig(cfg);
    } catch {
      /* non-fatal: the record already has the data */
    }
  }

  const r = rebuild({ recordDir: recordDir() });

  return NextResponse.json({
    ok: true,
    login: summary.login,
    from: summary.from,
    to: summary.to,
    commits: summary.total,
    daysWithCommits: summary.daysWithCommits,
    capped: summary.capped,
    dailyRows: r.daily,
    syncedAt: cfg?.githubSyncedAt ?? null,
    series: summary.days.slice(-30),
  });
}
