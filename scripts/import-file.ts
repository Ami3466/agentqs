#!/usr/bin/env tsx
/**
 * agentqs import:file — pull a Tier-2 local file source into the record.
 *
 * One CLI for every FileImporter (Chrome history · iPhone backup). Flow: resolve
 * a local file (explicit --path, else probe the platform defaults) → read a
 * window → normalize → merge record/daily/<source>.csv → optionally rebuild.
 *
 *   tsx scripts/import-file.ts --source chrome --rebuild
 *   tsx scripts/import-file.ts --source chrome --path ~/…/Default/History --days 30 --rebuild
 *   tsx scripts/import-file.ts --source iphone --path ~/…/MobileSync/Backup --rebuild
 *
 * File sources read *your* disk, so they run locally (CLI / daemon), never on the
 * server. A remote/Docker instance receives the rows through git — the record is
 * the sync layer.
 *
 * Flags:
 *   --source <id>   chrome | iphone                          (required)
 *   --path <file>   local file / backup dir (default: probe platform locations)
 *   --days <n>      trailing window (default: the WHOLE file — it is finite and on disk)
 *   --from <date>   window start YYYY-MM-DD (overrides --days)
 *   --to <date>     window end   YYYY-MM-DD (default: today)
 *   --record <dir>  record dir to write (default: <data>/record)
 *   --data <dir>    data dir the defaults derive from
 *   --rebuild       rebuild the SQLite cache and report the source's daily rows
 *   --json          print the result as JSON
 *   -h, --help      show this help
 */
import Database from "better-sqlite3";
import {
  importFile,
  resolveFilePath,
  type FileImporter,
} from "../src/lib/importers/file-plugin";
import { FILE_IMPORTERS, fileImporterById } from "../src/lib/importers/files/registry";
import { windowDays } from "../src/lib/importers/plugin";
import { rebuild } from "../src/lib/record";
import { dbPath, recordDir } from "../src/lib/paths";

interface Args {
  source?: string;
  path?: string;
  days?: string;
  from?: string;
  to?: string;
  record?: string;
  data?: string;
  rebuild: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { rebuild: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--source": a.source = argv[++i]; break;
      case "--path": a.path = argv[++i]; break;
      case "--days": a.days = argv[++i]; break;
      case "--from": a.from = argv[++i]; break;
      case "--to": a.to = argv[++i]; break;
      case "--record": a.record = argv[++i]; break;
      case "--data": a.data = argv[++i]; break;
      case "--rebuild": a.rebuild = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default:
        console.error(`import:file: unknown argument "${argv[i]}"`);
        process.exit(2);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    process.stdout.write(
      `agentqs import:file — pull a Tier-2 local file source into the record\n\n` +
        `Sources: ${FILE_IMPORTERS.map((f) => f.id).join(" · ")}\n` +
        `Usage: tsx scripts/import-file.ts --source <id> [--path <file>] [--days <n>] [--rebuild]\n`,
    );
    if (!args.source) process.exit(2);
    return;
  }

  const importer = fileImporterById(args.source) as FileImporter | undefined;
  if (!importer) {
    console.error(
      `import:file: unknown source "${args.source}". Try: ${FILE_IMPORTERS.map((f) => f.id).join(", ")}`,
    );
    process.exit(2);
  }

  const filePath = resolveFilePath(importer, args.path);
  if (!filePath) {
    const where = args.path
      ? `path not found: ${args.path}`
      : `no file found. Probed:\n    ${importer.defaultPaths().join("\n    ")}`;
    console.error(`import:file: ${importer.name} — ${where}\n  Pass --path <file> to point at it.`);
    process.exit(2);
  }

  const rDir = args.record ?? recordDir(args.data);
  const dbFile = dbPath(args.data);
  // A FILE IS FINITE AND ALREADY ON YOUR DISK, so it is read WHOLE. Clipping your own
  // ten-year Chrome history to a trailing 90 days throws away years that were sitting
  // right there — and because every later run re-asks for the same trailing 90, those
  // years are never fetched even once. This is the banned hardcoded window (CLAUDE.md),
  // and it outlived its own fix: cli-core stopped doing it, these two shipped faces did
  // not — including the daemon the README tells hosted users to schedule.
  // `--days N` still means exactly that, for someone who wants a quick top-up.
  const win = windowDays(args.days ? Number(args.days) : 1);
  const from = args.from ?? (args.days ? win.from : "0001-01-01");
  const to = args.to ?? win.to;

  let summary;
  try {
    summary = await importFile(importer, { path: filePath, from, to }, rDir);
  } catch (e) {
    console.error(`import:file: ${(e as Error).message}`);
    process.exit(1);
  }

  let rebuilt: { daily: number; source: number } | null = null;
  if (args.rebuild) {
    const r = rebuild({ recordDir: rDir, dbPath: dbFile });
    const db = new Database(dbFile, { readonly: true });
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM daily WHERE source = ?").get(importer.id) as { n: number }
    ).n;
    db.close();
    rebuilt = { daily: r.daily, source: n };
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...summary, rebuilt }, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `Imported ${importer.name}:\n` +
      `  source file   ${summary.path}\n` +
      `  window        ${summary.from} … ${summary.to}\n` +
      `  days          ${summary.daysWithData}\n` +
      `  metrics       ${summary.metrics.join(", ") || "(none in window)"}\n` +
      `  cells         ${summary.cells}\n` +
      `  rows in file  ${summary.rows}\n` +
      `  file          ${summary.file}\n`,
  );
  if (rebuilt) {
    process.stdout.write(
      `\nRebuilt cache: ${rebuilt.daily} daily rows (${rebuilt.source} from ${importer.id}).\n`,
    );
  }
}

void main();
