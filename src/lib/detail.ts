import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { detailPath } from "./paths";

/**
 * The detail store — every point behind the daily rollups. The record keeps
 * dense streams as small per-day files (record/whoop/hr/<day>.csv, one row per
 * minute); this module derives them into plain SQL tables in <dataDir>/detail.db
 * so the numbers stay indexed AS numbers and chat / `agentqs query` can
 * correlate at full grain (`detail.heart_rate`), not just day-to-day.
 *
 * Only the derived tables are touched (DROP + re-insert, deterministic from the
 * record). Tables landed directly by importers (chrome_visits) are left alone —
 * the store mixes derived and landed tables on purpose so there is exactly one
 * attach point.
 */

export interface DetailBuildResult {
  file: string | null; // null → no dense streams in the record, nothing written
  hrDays: number;
  hrSamples: number;
}

/** Per-day per-minute heart-rate files, as WHOOP's importer writes them. */
function hrDir(recordDir: string): string {
  return path.join(recordDir, "whoop", "hr");
}

/**
 * (Re)derive the detail store's heart_rate table from the record. No-op when the
 * record holds no per-minute files — an empty detail.db is never created. Writes
 * to whichever file `detailPath` resolves (a legacy hires.db keeps its name so
 * its landed tables stay in the same attachable file).
 */
export function buildDetailHeartRate(rDir: string, dataDir: string): DetailBuildResult {
  const dir = hrDir(rDir);
  let days: string[] = [];
  try {
    days = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
      .sort();
  } catch {
    /* no per-minute streams in this record */
  }
  if (days.length === 0) return { file: null, hrDays: 0, hrSamples: 0 };

  const file = detailPath(dataDir);
  const db = new Database(file);
  try {
    db.exec(
      "DROP TABLE IF EXISTS heart_rate;" +
        "CREATE TABLE heart_rate (datetime TEXT, timestamp_ms INTEGER PRIMARY KEY, hr INTEGER);",
    );
    const ins = db.prepare("INSERT OR REPLACE INTO heart_rate (datetime, timestamp_ms, hr) VALUES (?,?,?)");
    let samples = 0;
    const insertAll = db.transaction(() => {
      for (const day of days) {
        const lines = fs.readFileSync(path.join(dir, day), "utf8").split("\n");
        for (const line of lines.slice(1)) {
          const i = line.indexOf(",");
          if (i < 0) continue;
          const datetime = line.slice(0, i).trim();
          const hr = Number(line.slice(i + 1).trim());
          const ts = Date.parse(datetime);
          if (!Number.isFinite(ts) || !Number.isFinite(hr)) continue;
          ins.run(datetime, ts, Math.round(hr));
          samples += 1;
        }
      }
    });
    insertAll();
    return { file, hrDays: days.length, hrSamples: samples };
  } finally {
    db.close();
  }
}
