#!/usr/bin/env tsx
/**
 * agentqs import:source — pull a Tier-1 plugin source into the record.
 *
 * One CLI for every single-credential record-contract plugin (RescueTime ·
 * Google Calendar · Spotify). WHOOP uses the unofficial app login (two fields +
 * a per-minute stream), so it has its own path: `agentqs whoop connect` then
 * `agentqs sync whoop`. Flow: credential → fetch → normalize → merge
 * record/daily/<source>.csv → optionally rebuild the SQLite cache.
 *
 *   tsx scripts/import-source.ts --source rescuetime --credential <key> --rebuild
 *   tsx scripts/import-source.ts --source spotify --credential <token> --days 30
 *   tsx scripts/import-source.ts --source gcal --fixture samples/gcal-events.json \
 *       --from 2026-06-01 --to 2026-06-30 --record /tmp/rec --rebuild
 *
 * Credential precedence: --credential → <SOURCE>_TOKEN/KEY env → saved config.
 *
 * Flags:
 *   --source <id>     rescuetime | gcal | spotify   (required)
 *   --credential <c>  API key / OAuth access token
 *   --days <n>        trailing window length in days (default: 90)
 *   --from <date>     window start YYYY-MM-DD (overrides --days)
 *   --to <date>       window end   YYYY-MM-DD (default: today)
 *   --record <dir>    record dir to write (default: <data>/record)
 *   --data <dir>      data dir the defaults derive from
 *   --fixture <file>  offline: JSON body to feed the plugin (skips the network)
 *   --rebuild         rebuild the SQLite cache and report the source's daily rows
 *   --json            print the result as JSON
 *   -h, --help        show this help
 */
import fs from "fs";
import Database from "better-sqlite3";
import { importPlugin, fixtureFetch, resolveCredential, windowDays } from "../src/lib/importers/plugin";
import { pluginById, PLUGINS } from "../src/lib/importers/registry";
import { rebuild } from "../src/lib/record";
import { dbPath, recordDir } from "../src/lib/paths";

interface Args {
  source?: string;
  credential?: string;
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
    switch (argv[i]) {
      case "--source": a.source = argv[++i]; break;
      case "--credential": a.credential = argv[++i]; break;
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
        console.error(`import:source: unknown argument "${argv[i]}"`);
        process.exit(2);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    process.stdout.write(
      `agentqs import:source — pull a Tier-1 plugin source into the record\n\n` +
        `Sources: ${PLUGINS.map((p) => p.id).join(" · ")}\n` +
        `Usage: tsx scripts/import-source.ts --source <id> [--credential <c>] [--days <n>] [--rebuild]\n`,
    );
    if (!args.source) process.exit(2);
    return;
  }

  const plugin = pluginById(args.source);
  if (!plugin) {
    console.error(`import:source: unknown source "${args.source}". Try: ${PLUGINS.map((p) => p.id).join(", ")}`);
    process.exit(2);
  }

  const rDir = args.record ?? recordDir(args.data);
  const dbFile = dbPath(args.data);
  const win = windowDays(args.days ? Number(args.days) : 90);
  const from = args.from ?? win.from;
  const to = args.to ?? win.to;

  const fetchImpl = args.fixture
    ? fixtureFetch(JSON.parse(fs.readFileSync(args.fixture, "utf8")))
    : undefined;
  const credential = resolveCredential(plugin, args.credential);

  if (!fetchImpl && plugin.requiresCredential && !credential) {
    console.error(
      `import:source: no credential for ${plugin.name}. Pass --credential, set ${plugin.envKey}, or save one in the Pipeline tab.`,
    );
    process.exit(2);
  }

  let summary;
  try {
    summary = await importPlugin(plugin, { credential, from, to, fetchImpl }, rDir);
  } catch (e) {
    console.error(`import:source: ${(e as Error).message}`);
    process.exit(1);
  }

  let rebuilt: { daily: number; source: number } | null = null;
  if (args.rebuild) {
    const r = rebuild({ recordDir: rDir, dbPath: dbFile });
    const db = new Database(dbFile, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM daily WHERE source = ?").get(plugin.id) as { n: number }).n;
    db.close();
    rebuilt = { daily: r.daily, source: n };
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...summary, rebuilt }, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `Imported ${plugin.name}:\n` +
      `  window        ${summary.from} … ${summary.to}\n` +
      `  days          ${summary.daysWithData}\n` +
      `  metrics       ${summary.metrics.join(", ")}\n` +
      `  cells         ${summary.cells}\n` +
      `  rows in file  ${summary.rows}\n` +
      `  file          ${summary.file}\n`,
  );
  if (rebuilt) {
    process.stdout.write(`\nRebuilt cache: ${rebuilt.daily} daily rows (${rebuilt.source} from ${plugin.id}).\n`);
  }
}

void main();
