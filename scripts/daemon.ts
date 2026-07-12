#!/usr/bin/env tsx
/**
 * agentqs daemon — the local ingest + git-sync loop for Tier-2 file sources.
 *
 * The plan's daemon is one binary (ingest | sync | query | chat | serve). This
 * loop implements the two subcommands that own the local-file story; `serve` /
 * `chat` / `query` are the Next app + agent from earlier loops.
 *
 *   agentqs daemon ingest [--days <n>] [--record <dir>] [--data <dir>]
 *       Run every FileImporter whose file is found on THIS machine (Chrome
 *       history, iPhone backup), merge each into the record, rebuild the cache
 *       once. This is how file sources "auto-sync locally".
 *
 *   agentqs daemon sync [--push] [--record <dir>] [--data <dir>] [-m <msg>]
 *       Commit the record repo (git add + commit). With --push, push to its
 *       upstream — the record IS the sync layer, so a remote/Docker replica sees
 *       everything after it pulls. Never pushes without --push.
 *
 *   agentqs daemon run  = ingest + sync (one-shot local refresh).
 *
 * Run: npm run daemon -- ingest --days 30
 */
import { execFileSync } from "child_process";
import fs from "fs";
import Database from "better-sqlite3";
import {
  importFile,
  resolveFilePath,
  wantsFullHistory,
} from "../src/lib/importers/file-plugin";
import { FILE_IMPORTERS } from "../src/lib/importers/files/registry";
import { windowDays } from "../src/lib/importers/plugin";
import { rebuild } from "../src/lib/record";
import { dbPath, recordDir } from "../src/lib/paths";

interface Args {
  cmd: string;
  days?: string;
  record?: string;
  data?: string;
  message?: string;
  push: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: argv[0] ?? "", push: false, json: false, help: false };
  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case "--days": a.days = argv[++i]; break;
      case "--record": a.record = argv[++i]; break;
      case "--data": a.data = argv[++i]; break;
      case "-m": case "--message": a.message = argv[++i]; break;
      case "--push": a.push = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default:
        console.error(`daemon: unknown argument "${argv[i]}"`);
        process.exit(2);
    }
  }
  return a;
}

const HELP = `agentqs daemon — local ingest + git-sync for file sources

Usage:
  agentqs daemon ingest [--days <n>] [--record <dir>] [--data <dir>]
  agentqs daemon sync   [--push] [-m <msg>] [--record <dir>] [--data <dir>]
  agentqs daemon run    [--push] [--days <n>]        # ingest, then sync

Ingest reads local files (${FILE_IMPORTERS.map((f) => f.id).join(", ")}) and merges
them into the record. Sync commits (and optionally pushes) the record repo — git
is the sync layer to a cloud replica.
`;

interface IngestResult {
  imported: Array<{ id: string; path: string; days: number; cells: number }>;
  skipped: Array<{ id: string; reason: string }>;
  dailyRows: number;
}

async function ingest(args: Args): Promise<IngestResult> {
  const rDir = args.record ?? recordDir(args.data);
  const dbFile = dbPath(args.data);
  const win = windowDays(args.days ? Number(args.days) : 90);

  const imported: IngestResult["imported"] = [];
  const skipped: IngestResult["skipped"] = [];
  let anyImported = false;

  for (const importer of FILE_IMPORTERS) {
    const filePath = resolveFilePath(importer);
    if (!filePath) {
      skipped.push({ id: importer.id, reason: "no local file found (probed defaults)" });
      continue;
    }
    try {
      // A lifetime export found at a default path (Apple Health export.zip)
      // must not be trimmed to the daemon's rolling window.
      const from = !args.days && wantsFullHistory(importer, filePath) ? "0001-01-01" : win.from;
      const s = await importFile(importer, { path: filePath, from, to: win.to }, rDir);
      imported.push({ id: importer.id, path: filePath, days: s.daysWithData, cells: s.cells });
      anyImported = true;
    } catch (e) {
      skipped.push({ id: importer.id, reason: (e as Error).message });
    }
  }

  // Rebuild once after all merges so the cache reflects every file source.
  let dailyRows = 0;
  if (anyImported) {
    dailyRows = rebuild({ recordDir: rDir, dbPath: dbFile }).daily;
  } else if (fs.existsSync(dbFile)) {
    const db = new Database(dbFile, { readonly: true });
    dailyRows = (db.prepare("SELECT COUNT(*) AS n FROM daily").get() as { n: number }).n;
    db.close();
  }
  return { imported, skipped, dailyRows };
}

function git(dir: string, gitArgs: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", dir, ...gitArgs], { encoding: "utf8" }).trim();
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const msg = err.stderr ? err.stderr.toString().trim() : err.message ?? "git failed";
    return { ok: false, out: msg };
  }
}

interface SyncResult {
  repo: string | null;
  committed: boolean;
  pushed: boolean;
  message: string;
}

function sync(args: Args): SyncResult {
  const rDir = args.record ?? recordDir(args.data);
  const top = git(rDir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return {
      repo: null,
      committed: false,
      pushed: false,
      message:
        `${rDir} is not a git repo. Make your record a private repo so it can sync:\n` +
        `    git -C ${rDir} init && git -C ${rDir} add -A && git -C ${rDir} commit -m "record"\n` +
        `    git -C ${rDir} remote add origin <your-private-repo>`,
    };
  }
  const repo = top.out;
  git(repo, ["add", "-A"]);
  const status = git(repo, ["status", "--porcelain"]);
  if (status.ok && status.out === "") {
    return { repo, committed: false, pushed: false, message: "record clean — nothing to commit" };
  }
  const msg = args.message || `agentqs: ingest ${new Date().toISOString()}`;
  const commit = git(repo, ["commit", "-m", msg]);
  if (!commit.ok) {
    return { repo, committed: false, pushed: false, message: `commit failed: ${commit.out}` };
  }
  let pushed = false;
  let message = `committed to ${repo}`;
  if (args.push) {
    const push = git(repo, ["push"]);
    pushed = push.ok;
    message += push.ok ? "; pushed to upstream" : `; push failed: ${push.out}`;
  } else {
    message += " (pass --push to send it to your cloud replica)";
  }
  return { repo, committed: true, pushed, message };
}

function reportIngest(r: IngestResult): void {
  process.stdout.write(`Ingested local file sources:\n`);
  for (const i of r.imported)
    process.stdout.write(`  ✓ ${i.id.padEnd(8)} ${i.days} days, ${i.cells} cells  (${i.path})\n`);
  for (const s of r.skipped)
    process.stdout.write(`  – ${s.id.padEnd(8)} skipped: ${s.reason}\n`);
  if (r.imported.length) process.stdout.write(`\nRebuilt cache: ${r.dailyRows} daily rows.\n`);
  else process.stdout.write(`\nNo local files found on this machine.\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.cmd) {
    process.stdout.write(HELP);
    if (!args.cmd) process.exit(2);
    return;
  }

  if (args.cmd === "ingest" || args.cmd === "run") {
    const r = await ingest(args);
    if (args.json && args.cmd === "ingest") {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    } else {
      reportIngest(r);
    }
  }

  if (args.cmd === "sync" || args.cmd === "run") {
    const s = sync(args);
    if (args.json && args.cmd === "sync") {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    } else {
      process.stdout.write(`\nSync: ${s.message}\n`);
    }
  }

  if (!["ingest", "sync", "run"].includes(args.cmd)) {
    console.error(`daemon: unknown command "${args.cmd}"`);
    process.stdout.write(HELP);
    process.exit(2);
  }
}

void main();
