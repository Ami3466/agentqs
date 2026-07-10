import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseGithubCsv, resolveGithubToken } from "@/lib/importers/github";
import { readSyncRuns } from "@/lib/sync-runs";
import { readSyncJob, startSyncJob } from "@/lib/sync-jobs";
import { wipeDemoOnImport } from "@/lib/demo";
import { connectSource, syncSource, testSourceCredential } from "@/lib/cli-core";

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
    job: readSyncJob("github"),
    lastRun: readSyncRuns().runs["github"] ?? null,
    total: days.reduce((n, d) => n + d.commits, 0),
    series: days.slice(-30),
  });
}

/**
 * Connect and/or sync GitHub. `{test: true, token?}` probes the token (nothing
 * saved); a fresh token is probed FIRST and only a working one stored. The sync
 * runs as a background job (202) — refreshing the page never kills it.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    token?: string;
    login?: string;
    days?: number;
    test?: boolean;
  };

  if (body.test === true) {
    try {
      return NextResponse.json(await testSourceCredential("github", body.token));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  if (body.token && body.token.trim()) {
    try {
      await testSourceCredential("github", body.token);
      connectSource("github", body.token);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  if (!resolveGithubToken() && !body.login) {
    return NextResponse.json(
      { error: "Add a GitHub token (or set GITHUB_TOKEN) to sync commits." },
      { status: 400 },
    );
  }

  wipeDemoOnImport(); // first real import clears the generic demo record

  const days = body.days && body.days > 0 ? body.days : undefined;
  const login = body.login;
  const job = startSyncJob("github", async (progress) => {
    const r = await syncSource({ id: "github", days, login, onProgress: progress });
    return { days: r.days, dailyRows: r.dailyRows };
  });

  return NextResponse.json({ ok: true, id: "github", name: "GitHub", job }, { status: 202 });
}
