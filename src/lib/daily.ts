import fs from "fs";
import { openReadonly, type DB } from "./db";
import { dbPath } from "./paths";

/**
 * Read-side view of the `daily` table — the rebuilt cache that Structure and the
 * importers write into. Long form: (date, source, metric, value). The Data tab's
 * preview and (later) the Journal read through here so "rows landed" is provable
 * straight from the derived store, not just the record text.
 */

export interface DailyCell {
  date: string;
  source: string;
  metric: string;
  value: string;
  num: number | null;
}

export interface SourceStat {
  source: string;
  metrics: number;
  rows: number;
  firstDate: string;
  lastDate: string;
}

export interface DailySummary {
  totalRows: number;
  sources: SourceStat[];
  recent: DailyCell[];
}

const EMPTY: DailySummary = { totalRows: 0, sources: [], recent: [] };

/** Summary of the daily cache: total rows, per-source stats, newest cells.
 * Returns an empty summary when the cache doesn't exist yet or can't be read. */
export function readDailySummary(file: string = dbPath(), limit = 30): DailySummary {
  if (!fs.existsSync(file)) return EMPTY;
  let db: DB;
  try {
    db = openReadonly(file);
  } catch {
    return EMPTY;
  }
  try {
    const total = (db.prepare("SELECT COUNT(*) AS n FROM daily").get() as { n: number }).n;
    const sources = db
      .prepare(
        `SELECT source,
                COUNT(DISTINCT metric) AS metrics,
                COUNT(*)               AS rows,
                MIN(date)              AS firstDate,
                MAX(date)              AS lastDate
         FROM daily GROUP BY source ORDER BY source`,
      )
      .all() as SourceStat[];
    const recent = db
      .prepare(
        `SELECT date, source, metric, value_text AS value, value_num AS num
         FROM daily ORDER BY date DESC, source ASC, metric ASC LIMIT ?`,
      )
      .all(limit) as DailyCell[];
    return { totalRows: total, sources, recent };
  } catch {
    return EMPTY; // stale/older schema without a daily table
  } finally {
    db.close();
  }
}
