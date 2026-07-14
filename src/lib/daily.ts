import fs from "fs";
import { ensureIndexes, openReadonly, type DB } from "./db";
import { dbPath } from "./paths";
import type { SourceCoverage } from "./sources";

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

/**
 * What every source actually landed — date range + counts, both layers (daily
 * rollups and events) in one pass. THE answer to "what synced and what didn't":
 * the Pipeline tab hangs each row's coverage line off this, and `pipeline`
 * reports it. A source missing from the map landed nothing.
 */
export function coverageBySource(file: string = dbPath()): Map<string, SourceCoverage> {
  const out = new Map<string, SourceCoverage>();
  if (!fs.existsSync(file)) return out;
  // Both GROUP BYs below are covered by (source, date). Without those indexes this
  // is a full scan of every event — the query that made the Pipeline tab time out.
  ensureIndexes(file);
  try {
    const db = openReadonly(file);
    try {
      const daily = db
        .prepare("SELECT source, COUNT(DISTINCT date) AS days, MIN(date) AS f, MAX(date) AS t FROM daily GROUP BY source")
        .all() as Array<{ source: string; days: number; f: string; t: string }>;
      for (const r of daily) out.set(r.source, { events: 0, days: r.days, from: r.f, to: r.t });
      const events = db
        .prepare("SELECT source, COUNT(*) AS n, MIN(date) AS f, MAX(date) AS t FROM events GROUP BY source")
        .all() as Array<{ source: string; n: number; f: string; t: string }>;
      for (const r of events) {
        const cur = out.get(r.source) ?? { events: 0, days: 0, from: null, to: null };
        cur.events = r.n;
        cur.from = cur.from && cur.from < r.f ? cur.from : r.f;
        cur.to = cur.to && cur.to > r.t ? cur.to : r.t;
        out.set(r.source, cur);
      }
    } finally {
      db.close();
    }
  } catch {
    /* stale/older cache — coverage shows as empty rather than failing the caller */
  }
  return out;
}

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
