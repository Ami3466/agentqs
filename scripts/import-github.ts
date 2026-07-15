#!/usr/bin/env tsx
/**
 * agentqs import:github — pull real commits/day from GitHub into the record.
 *
 * Flow: token → GitHub Search-Commits API → bucket by author-date → write
 * record/daily/github.csv (merged) → optionally rebuild the SQLite cache. The
 * record is the source of truth; the DB is derived.
 *
 *   tsx scripts/import-github.ts --token ghp_xxx --rebuild
 *   tsx scripts/import-github.ts --login torvalds --days 30 --record /tmp/rec --rebuild
 *   tsx scripts/import-github.ts --fixture samples/github-commits.json --login demo \
 *       --from 2026-06-01 --to 2026-06-14 --record /tmp/rec --rebuild
 *
 * Token precedence: --token → GITHUB_TOKEN env → saved config (githubToken).
 *
 * Flags:
 *   --token <pat>    GitHub personal access token
 *   --login <user>   author to search (default: the token's own user)
 *   --days <n>       window length in days (default: resume from the record)
 *   --from <date>    window start YYYY-MM-DD (overrides --days)
 *   --to <date>      window end   YYYY-MM-DD (default: today)
 *   --record <dir>   record dir to write (default: <data>/record)
 *   --data <dir>     data dir the defaults derive from (default: AGENTQS_DATA_DIR or ./data)
 *   --fixture <file> offline: JSON array of commit author-date strings (skips the network)
 *   --rebuild        rebuild the SQLite cache and report the github daily rows
 *   --json           print the result as JSON
 *   -h, --help       show this help
 */
import fs from "fs";
import Database from "better-sqlite3";
import {
  fetchGithubCommits,
  importGithub,
  resolveGithubToken,
  writeGithubRecord,
  type FetchLike,
  type ImportGithubSummary,
} from "../src/lib/importers/github";
import { syncWindow } from "../src/lib/cli-core";
import { rebuild } from "../src/lib/record";
import { dbPath, recordDir } from "../src/lib/paths";

interface Args {
  token?: string;
  login?: string;
  days?: string;
  from?: string;
  to?: string;
  record?: string;
  data?: string;
  fixture?: string;
  rebuild: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { rebuild: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--token": a.token = argv[++i]; break;
      case "--login": a.login = argv[++i]; break;
      case "--days": a.days = argv[++i]; break;
      case "--from": a.from = argv[++i]; break;
      case "--to": a.to = argv[++i]; break;
      case "--record": a.record = argv[++i]; break;
      case "--data": a.data = argv[++i]; break;
      case "--fixture": a.fixture = argv[++i]; break;
      case "--rebuild": a.rebuild = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default:
        console.error(`import:github: unknown argument "${arg}"`);
        process.exit(2);
    }
  }
  return a;
}

const HELP = `agentqs import:github — pull commits/day from GitHub into the record

Usage:
  tsx scripts/import-github.ts [--token <pat>] [--login <user>] [--days <n>]
                              [--from <date>] [--to <date>] [--record <dir>]
                              [--data <dir>] [--fixture <file>] [--rebuild] [--json]

Token precedence: --token → GITHUB_TOKEN env → saved config.
`;

/** Build a fetch stand-in from a fixture of ISO commit author-date strings. */
function fixtureFetch(file: string): FetchLike {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const dates: string[] = Array.isArray(raw)
    ? raw.map((d) => (typeof d === "string" ? d : String((d as { date?: string }).date)))
    : [];
  const page = {
    total_count: dates.length,
    items: dates.map((date) => ({ commit: { author: { date } } })),
  };
  return (async (url: string) => {
    const isFirstPage = new URL(url).searchParams.get("page") === "1";
    const body = isFirstPage ? page : { total_count: dates.length, items: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as FetchLike;
}

function fmt(s: ImportGithubSummary): string {
  const recent = s.days.slice(-7).map((d) => `${d.date}=${d.commits}`).join("  ");
  return [
    `  author        ${s.login}`,
    `  window        ${s.from} … ${s.to}`,
    `  commits       ${s.total}${s.capped ? " (capped at 1000)" : ""}`,
    `  active days   ${s.daysWithCommits}`,
    `  rows in file  ${s.rowsInFile}`,
    `  file          ${s.file}`,
    `  last 7 days    ${recent}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const rDir = args.record ?? recordDir(args.data);
  const dbFile = dbPath(args.data);

  // Window from the RECORD, never a hardcoded trailing default: --from/--to win, then
  // --days as asked, else resume from the last recorded day. Full first-time backfill
  // lives in `agentqs sync github`.
  const win = syncWindow(rDir, "github", { days: args.days ? Number(args.days) : undefined });
  const from = args.from ?? win.from;
  const to = args.to ?? win.to;

  const token = resolveGithubToken(args.token);
  const fetchImpl = args.fixture ? fixtureFetch(args.fixture) : undefined;

  if (!fetchImpl && !token && !args.login) {
    console.error(
      "import:github: no token found. Pass --token, set GITHUB_TOKEN, or save one in Settings.\n" +
        "For a public author without a token, pass --login <user>.",
    );
    process.exit(2);
  }

  let summary: ImportGithubSummary;
  try {
    if (fetchImpl) {
      // Offline: exercise the real bucketing → write pipeline against a fixture.
      const res = await fetchGithubCommits({ login: args.login, from, to, fetchImpl });
      const w = writeGithubRecord(rDir, res.days);
      summary = {
        ...res,
        file: w.file,
        daysWithCommits: res.days.filter((d) => d.commits > 0).length,
        rowsInFile: w.rowsInFile,
      };
    } else {
      summary = await importGithub({ token, login: args.login, from, to, recordDir: rDir });
    }
  } catch (e) {
    console.error(`import:github: ${(e as Error).message}`);
    process.exit(1);
  }

  let rebuilt: { daily: number; github: number } | null = null;
  if (args.rebuild) {
    const r = rebuild({ recordDir: rDir, dbPath: dbFile });
    const db = new Database(dbFile, { readonly: true });
    const github = (
      db.prepare("SELECT COUNT(*) AS n FROM daily WHERE source = 'github'").get() as { n: number }
    ).n;
    db.close();
    rebuilt = { daily: r.daily, github };
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...summary, rebuilt }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Imported GitHub commits/day:\n${fmt(summary)}\n`);
  if (rebuilt) {
    process.stdout.write(
      `\nRebuilt cache: ${rebuilt.daily} daily rows (${rebuilt.github} from github).\n`,
    );
  }
}

void main();
