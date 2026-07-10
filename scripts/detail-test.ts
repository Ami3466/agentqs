#!/usr/bin/env tsx
/**
 * Ships-when proof for the detail store.
 *
 *   MAIN: per-minute heart-rate files in the record (record/whoop/hr/<day>.csv)
 *   are derived into <dataDir>/detail.db by rebuild, and the cache attaches the
 *   store so SQL reaches the numbers at full grain as `detail.heart_rate`
 *   (legacy alias `hires.heart_rate` still answers). Deterministic: rebuilding
 *   twice yields the same table.
 *   PLUS: a legacy hires.db keeps its filename and its landed tables
 *   (chrome_visits) untouched — only the derived heart_rate table is rebuilt.
 *   A record with no dense streams never grows an empty detail.db.
 *
 * Drives the production core (rebuild → buildDetailHeartRate → openReadonly)
 * against temp data dirs. No network, no LLM. Run: npm run detail:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { openReadonly } from "../src/lib/db";
import { detailPath } from "../src/lib/paths";
import { rebuild } from "../src/lib/record";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function seedRecord(dataDir: string, withHr: boolean): void {
  const daily = path.join(dataDir, "record", "daily");
  fs.mkdirSync(daily, { recursive: true });
  fs.writeFileSync(path.join(daily, "whoop.csv"), "date,recovery,hr_avg\n2026-01-01,55,62\n2026-01-02,71,58\n");
  if (!withHr) return;
  const hr = path.join(dataDir, "record", "whoop", "hr");
  fs.mkdirSync(hr, { recursive: true });
  fs.writeFileSync(
    path.join(hr, "2026-01-01.csv"),
    "time,bpm\n2026-01-01T00:00:00.000Z,61\n2026-01-01T00:01:00.000Z,63\n2026-01-01T00:02:00.000Z,62\n",
  );
  fs.writeFileSync(
    path.join(hr, "2026-01-02.csv"),
    "time,bpm\n2026-01-02T00:00:00.000Z,57\nnot-a-row\n2026-01-02T00:01:00.000Z,oops\n2026-01-02T00:02:00.000Z,59\n",
  );
  // Not a per-day file — the builder must ignore it.
  fs.writeFileSync(path.join(hr, "notes.txt"), "junk\n");
}

function hrDump(dbFile: string): string {
  const db = openReadonly(dbFile);
  try {
    return JSON.stringify(db.prepare("SELECT datetime, timestamp_ms, hr FROM detail.heart_rate ORDER BY timestamp_ms").all());
  } finally {
    db.close();
  }
}

console.log("detail store — derive per-minute streams from the record");

// ---- MAIN: hr files → detail.db, attached for SQL --------------------------
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-detail-"));
  seedRecord(dataDir, true);
  const res = rebuild({ dataDir });
  check("rebuild reports the derived samples", res.detailHrSamples === 5, `got ${res.detailHrSamples}`);
  check("detail.db created beside the cache", fs.existsSync(path.join(dataDir, "detail.db")));

  const db = openReadonly(res.dbPath);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM detail.heart_rate").get() as { n: number }).n;
  const first = db.prepare("SELECT hr FROM detail.heart_rate ORDER BY timestamp_ms LIMIT 1").get() as { hr: number };
  const legacy = (db.prepare("SELECT COUNT(*) AS n FROM hires.heart_rate").get() as { n: number }).n;
  db.close();
  check("detail.heart_rate holds the 5 valid samples (junk lines skipped)", count === 5, `got ${count}`);
  check("values land as numbers", first.hr === 61, `got ${first.hr}`);
  check("legacy `hires` alias still answers", legacy === 5, `got ${legacy}`);

  const before = hrDump(res.dbPath);
  rebuild({ dataDir });
  check("rebuild is deterministic (same table twice)", hrDump(res.dbPath) === before);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ---- PLUS: legacy hires.db keeps its name and landed tables -----------------
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-detail-legacy-"));
  seedRecord(dataDir, true);
  const legacyFile = path.join(dataDir, "hires.db");
  const pre = new Database(legacyFile);
  pre.exec("CREATE TABLE chrome_visits (ts TEXT, domain TEXT, category TEXT, title TEXT, url TEXT)");
  pre.prepare("INSERT INTO chrome_visits VALUES (?,?,?,?,?)").run("2026-01-01T10:00:00Z", "example.com", "", "t", "u");
  pre.close();

  const res = rebuild({ dataDir });
  check("derive writes into the legacy file", res.detailHrSamples === 5 && !fs.existsSync(path.join(dataDir, "detail.db")));
  check("detailPath resolves the legacy file", detailPath(dataDir) === legacyFile);
  const db = openReadonly(res.dbPath);
  const visits = (db.prepare("SELECT COUNT(*) AS n FROM detail.chrome_visits").get() as { n: number }).n;
  const hr = (db.prepare("SELECT COUNT(*) AS n FROM detail.heart_rate").get() as { n: number }).n;
  db.close();
  check("landed chrome_visits untouched", visits === 1, `got ${visits}`);
  check("heart_rate derived alongside", hr === 5, `got ${hr}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// ---- PLUS: no dense streams → no empty store --------------------------------
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-detail-none-"));
  seedRecord(dataDir, false);
  const res = rebuild({ dataDir });
  check("no hr files → no samples, no detail.db", res.detailHrSamples === 0 && !fs.existsSync(path.join(dataDir, "detail.db")));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
