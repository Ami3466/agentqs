#!/usr/bin/env tsx
/**
 * agentqs rebuild — rebuild the SQLite cache from the git record.
 *
 * The record (plain-text CSV/JSONL under record/) is the source of truth; the
 * SQLite file is a throwaway derived index. This command reads the record and
 * writes a fresh DB. It is pure: same record bytes in -> same DB bytes out.
 *
 *   tsx scripts/rebuild.ts                       # rebuild the configured data dir
 *   tsx scripts/rebuild.ts --record samples/record --out /tmp/agentqs.db
 *   tsx scripts/rebuild.ts --record samples/record --verify   # build twice, assert identical
 *
 * Flags:
 *   --record <dir>   record dir to read (default: <data>/record)
 *   --out <path>     DB file to write (default: <data>/agentqs.db)
 *   --data <dir>     data dir the two defaults derive from (default: AGENTQS_DATA_DIR or ./data)
 *   --verify         rebuild twice into temp files and prove the bytes match
 *   --json           print the result as JSON
 *   -h, --help       this help
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { rebuild, type RebuildResult } from "../src/lib/record";

interface Args {
  record?: string;
  out?: string;
  data?: string;
  verify: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { verify: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--record": a.record = argv[++i]; break;
      case "--out": a.out = argv[++i]; break;
      case "--data": a.data = argv[++i]; break;
      case "--verify": a.verify = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help": a.help = true; break;
      default:
        console.error(`rebuild: unknown argument "${arg}"`);
        process.exit(2);
    }
  }
  return a;
}

const HELP = `agentqs rebuild — rebuild the SQLite cache from the git record

Usage:
  tsx scripts/rebuild.ts [--record <dir>] [--out <path>] [--data <dir>] [--verify] [--json]

Flags:
  --record <dir>   record dir to read (default: <data>/record)
  --out <path>     DB file to write (default: <data>/agentqs.db)
  --data <dir>     data dir the defaults derive from (default: AGENTQS_DATA_DIR or ./data)
  --verify         rebuild twice into temp files and assert byte-identical output
  --json           print the result as JSON
  -h, --help       show this help
`;

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fmt(r: RebuildResult): string {
  return [
    `  daily rows    ${r.daily}`,
    `  inbox rows    ${r.inbox}`,
    `  session rows  ${r.sessions}`,
    `  record hash   ${r.recordHash.slice(0, 16)}…`,
  ].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const base = { dataDir: args.data, recordDir: args.record };

  if (args.verify) {
    // Deterministic-rebuild proof: build the same record twice into two
    // independent files and compare the bytes. This is Loop 2's ships-when.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-verify-"));
    const aPath = path.join(tmp, "a.db");
    const bPath = path.join(tmp, "b.db");
    let a: RebuildResult, b: RebuildResult;
    try {
      a = rebuild({ ...base, dbPath: aPath });
      b = rebuild({ ...base, dbPath: bPath });
      const aHash = sha256File(aPath);
      const bHash = sha256File(bPath);
      const ok = aHash === bHash;
      if (args.json) {
        process.stdout.write(
          JSON.stringify({ ok, sha256: aHash, recordHash: a.recordHash, rows: { daily: a.daily, inbox: a.inbox, sessions: a.sessions } }, null, 2) + "\n",
        );
      } else {
        process.stdout.write(`Rebuilt from record twice:\n${fmt(a)}\n\n`);
        process.stdout.write(`  build A sha256  ${aHash}\n`);
        process.stdout.write(`  build B sha256  ${bHash}\n\n`);
        process.stdout.write(ok ? "PASS — identical DB.\n" : "FAIL — builds differ.\n");
      }
      if (!ok || a.recordHash !== b.recordHash) process.exit(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  const r = rebuild({ ...base, dbPath: args.out });
  if (args.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    process.stdout.write(`Rebuilt ${r.dbPath}\n${fmt(r)}\n`);
  }
}

main();
