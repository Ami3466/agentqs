import fs from "fs";
import { ensureIndexes, openReadonly } from "./db";
import { dbPath } from "./paths";

/**
 * Coverage: the shape of the whole record at a glance — every source, how much it
 * holds, its date span, and a per-year row histogram. This is the "front door" data:
 * the Overview tab renders it as a source×year heatmap so a user sees what they have
 * and where the holes are, instead of only the flat Journal table. Pure and sync
 * (mirrors `coverageBySource` in daily.ts): reads the rebuilt `daily` cache, no LLM,
 * no network, so any face (UI, API, CLI, MCP) can call it.
 */

export interface SourceCoverage {
  source: string;
  rows: number; // total daily rows landed by this source
  days: number; // distinct calendar days it covers
  first: string | null; // earliest date (YYYY-MM-DD)
  last: string | null; // latest date (YYYY-MM-DD)
  byYear: Record<string, number>; // year -> row count (only years with data)
}

export interface CoverageReport {
  years: number[]; // every year from the earliest to the latest source, ascending
  sources: SourceCoverage[]; // sorted by total rows, richest first
  totalRows: number;
  totalDays: number; // distinct days across the whole record
  span: { first: string | null; last: string | null };
}

const EMPTY: CoverageReport = {
  years: [],
  sources: [],
  totalRows: 0,
  totalDays: 0,
  span: { first: null, last: null },
};

/**
 * Build the coverage report from the SQLite cache. Two GROUP BYs over `daily`
 * (per-source totals, per-source-per-year counts), both covered by the (source, date)
 * index, so it stays fast on a multi-hundred-thousand-row record.
 */
export function buildCoverage(file: string = dbPath()): CoverageReport {
  if (!fs.existsSync(file)) return EMPTY;
  ensureIndexes(file);
  const db = openReadonly(file);
  try {
    const perSource = db
      .prepare(
        "SELECT source, COUNT(*) AS rows, COUNT(DISTINCT date) AS days, MIN(date) AS first, MAX(date) AS last FROM daily GROUP BY source",
      )
      .all() as Array<{ source: string; rows: number; days: number; first: string; last: string }>;
    if (perSource.length === 0) return EMPTY;

    const perYear = db
      .prepare(
        "SELECT source, CAST(substr(date, 1, 4) AS INTEGER) AS yr, COUNT(*) AS n FROM daily GROUP BY source, yr",
      )
      .all() as Array<{ source: string; yr: number; n: number }>;

    const byYear = new Map<string, Record<string, number>>();
    let minYear = Infinity;
    let maxYear = -Infinity;
    for (const r of perYear) {
      if (!Number.isFinite(r.yr) || r.yr <= 0) continue;
      const m = byYear.get(r.source) ?? {};
      m[String(r.yr)] = r.n;
      byYear.set(r.source, m);
      if (r.yr < minYear) minYear = r.yr;
      if (r.yr > maxYear) maxYear = r.yr;
    }

    const years: number[] =
      Number.isFinite(minYear) && Number.isFinite(maxYear)
        ? Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i)
        : [];

    const sources: SourceCoverage[] = perSource
      .map((s) => ({
        source: s.source,
        rows: s.rows,
        days: s.days,
        first: s.first ?? null,
        last: s.last ?? null,
        byYear: byYear.get(s.source) ?? {},
      }))
      .sort((a, b) => b.rows - a.rows || a.source.localeCompare(b.source));

    const totalRows = sources.reduce((n, s) => n + s.rows, 0);
    const range = db
      .prepare("SELECT MIN(date) AS first, MAX(date) AS last, COUNT(DISTINCT date) AS days FROM daily")
      .get() as { first: string | null; last: string | null; days: number };

    return {
      years,
      sources,
      totalRows,
      totalDays: range?.days ?? 0,
      span: { first: range?.first ?? null, last: range?.last ?? null },
    };
  } finally {
    db.close();
  }
}
