import fs from "fs";
import { openReadonly, type DB } from "./db";
import { dbPath } from "./paths";

/**
 * Read-side view that powers the Journal tab. Same rebuilt cache the Data-tab
 * preview reads, but shaped for browsing a life day-by-day: the long-form daily
 * table is pivoted to one record per day, and each day also carries the memos
 * (inbox captures) and mentor/therapy sessions that landed on it. The Timeline
 * view walks `days`; the Table view uses `days` as rows and `metrics` as
 * Notion-style, show/hide/reorder/resize columns.
 */

/** A saved Table layout — persisted per user in config.json (journalViews). */
export interface JournalView {
  id: string;
  name: string;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnSizing: Record<string, number>;
}

/** One pivoted column: a (source, metric) pair from the daily table. */
export interface MetricColumn {
  key: string; // `${source}.${metric}` — stable column id
  source: string;
  metric: string;
  numeric: boolean; // every non-empty cell parsed as a number → right-align + mono
}

export interface JournalMemo {
  id: string;
  ts: string;
  source: string; // memo | drop | telegram | chat | ...
  kind: string; // text | csv | file | ...
  text: string;
  status: string; // pending | structured
}

export interface JournalSession {
  id: string;
  date: string;
  startedAt: string;
  skill: string; // internal column: the mentor id (resolve to a display name via mentorById)
  title: string | null;
  summary: string | null;
  insights: string[];
  commitments: string[];
}

export interface JournalDayValue {
  text: string;
  num: number | null;
}

export interface JournalDay {
  date: string;
  values: Record<string, JournalDayValue>; // keyed by MetricColumn.key
  memos: JournalMemo[];
  sessions: JournalSession[];
}

export interface JournalData {
  metrics: MetricColumn[];
  days: JournalDay[]; // newest first
  totalDays: number;
  totalCells: number; // non-empty daily cells (matches daily-table row count)
}

const EMPTY: JournalData = { metrics: [], days: [], totalDays: 0, totalCells: 0 };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Pivot the rebuilt cache into per-day records + column metadata for the Journal.
 * Returns an empty view when the cache doesn't exist yet or can't be read. */
export function readJournal(file: string = dbPath()): JournalData {
  if (!fs.existsSync(file)) return EMPTY;
  let db: DB;
  try {
    db = openReadonly(file);
  } catch {
    return EMPTY;
  }
  try {
    const daily = db
      .prepare(
        `SELECT date, source, metric, value_text AS text, value_num AS num
         FROM daily ORDER BY date, source, metric`,
      )
      .all() as { date: string; source: string; metric: string; text: string; num: number | null }[];

    const sessionsRaw = db
      .prepare(
        `SELECT id, date, started_at AS startedAt, skill, title, summary, insights, commitments
         FROM sessions`,
      )
      .all() as {
      id: string;
      date: string | null;
      startedAt: string;
      skill: string;
      title: string | null;
      summary: string | null;
      insights: string | null;
      commitments: string | null;
    }[];

    const inboxRaw = db
      .prepare(
        `SELECT id, ts, source, kind, text, status
         FROM raw_inbox WHERE status != 'discarded' ORDER BY ts`,
      )
      .all() as {
      id: string;
      ts: string;
      source: string;
      kind: string;
      text: string;
      status: string;
    }[];

    // Column metadata + per-day values.
    const days = new Map<string, JournalDay>();
    const ensure = (date: string): JournalDay => {
      let d = days.get(date);
      if (!d) {
        d = { date, values: {}, memos: [], sessions: [] };
        days.set(date, d);
      }
      return d;
    };

    const colMeta = new Map<string, MetricColumn>();
    let totalCells = 0;
    for (const row of daily) {
      const key = `${row.source}.${row.metric}`;
      let col = colMeta.get(key);
      if (!col) {
        col = { key, source: row.source, metric: row.metric, numeric: true };
        colMeta.set(key, col);
      }
      if (row.num == null) col.numeric = false;
      ensure(row.date).values[key] = { text: row.text, num: row.num };
      totalCells++;
    }

    for (const s of sessionsRaw) {
      const date = s.date || s.startedAt.slice(0, 10);
      if (!date) continue;
      ensure(date).sessions.push({
        id: s.id,
        date,
        startedAt: s.startedAt,
        skill: s.skill,
        title: s.title,
        summary: s.summary,
        insights: jsonArray(s.insights),
        commitments: jsonArray(s.commitments),
      });
    }

    for (const it of inboxRaw) {
      const date = (it.ts || "").slice(0, 10);
      if (!date) continue;
      ensure(date).memos.push({
        id: it.id,
        ts: it.ts,
        source: it.source,
        kind: it.kind,
        text: it.text,
        status: it.status,
      });
    }

    const metrics = [...colMeta.values()].sort(
      (a, b) => cmp(a.source, b.source) || cmp(a.metric, b.metric),
    );
    const ordered = [...days.values()].sort((a, b) => cmp(b.date, a.date)); // newest first

    return { metrics, days: ordered, totalDays: ordered.length, totalCells };
  } catch {
    return EMPTY; // stale/older schema
  } finally {
    db.close();
  }
}
