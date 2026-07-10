import fs from "fs";
import { openReadonly, type DB } from "./db";
import { dbPath } from "./paths";

/**
 * Read-side view that powers the Journal tab. Same rebuilt cache the Pipeline-tab
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
  skill: string; // mentor | therapist | coach | ...
  title: string | null;
  summary: string | null;
  insights: string[];
  commitments: string[];
}

export interface JournalEvent {
  id: string;
  date: string;
  ts: string;
  source: string;
  title: string | null;
  text: string;
  url: string | null;
  meta: unknown;
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
  events: JournalEvent[];
  eventCount: number;
}

export interface JournalData {
  metrics: MetricColumn[];
  days: JournalDay[]; // newest first
  totalDays: number;
  totalCells: number; // non-empty daily cells across the visible (up-to-today) days
  totalEvents: number; // event-layer rows (activity, browsing, plays) — the bulk of a lifetime record
}

const EMPTY: JournalData = { metrics: [], days: [], totalDays: 0, totalCells: 0, totalEvents: 0 };

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

export interface ReadJournalOptions {
  file?: string;
  today?: string;
  /** Most-recent days of VALUES to return; "all" = full history, 0 = metadata only.
   *  A lifetime record holds thousands of days — serializing all of them into one
   *  response froze the Journal page, so windowing is the default. `metrics`,
   *  `totalDays` and `totalCells` always describe the FULL history. */
  days?: number | "all";
  /** Blank the text of every cell (the Graphs payload — it only reads numbers,
   *  and the text is megabytes of journal writing). */
  numericOnly?: boolean;
}

/** Pivot the rebuilt cache into per-day records + column metadata for the Journal.
 * Future-dated days (date > `today`) are dropped so the Log and Timeline only ever
 * show up to the present. Returns an empty view when the cache doesn't exist yet or
 * can't be read. */
export function readJournal(opts: ReadJournalOptions = {}): JournalData {
  const file = opts.file ?? dbPath();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const windowDays = opts.days ?? "all";
  if (!fs.existsSync(file)) return EMPTY;
  let db: DB;
  try {
    db = openReadonly(file);
  } catch {
    return EMPTY;
  }
  try {
    // Full-history totals + column metadata come from cheap aggregates, so the
    // windowed payload still reports the real record size and every column.
    const totals = db
      .prepare("SELECT COUNT(DISTINCT date) AS days, COUNT(*) AS cells FROM daily WHERE date <= ?")
      .get(today) as { days: number; cells: number };
    // Daily cells alone understate a lifetime record by ~10x (a day of browsing is
    // one cell but hundreds of events), so the header reports both layers.
    let totalEvents = 0;
    try {
      totalEvents = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE date <= ?").get(today) as { n: number }).n;
    } catch {
      /* pre-events cache — the journal still renders */
    }
    const colRows = db
      .prepare(
        `SELECT source, metric, COUNT(*) - COUNT(value_num) AS nonNumeric
         FROM daily WHERE date <= ? GROUP BY source, metric ORDER BY source, metric`,
      )
      .all(today) as Array<{ source: string; metric: string; nonNumeric: number }>;

    // Resolve the window's start date from the N most recent days with data.
    let minDate = "0000-00-00";
    if (windowDays === 0) minDate = "9999-99-99";
    else if (typeof windowDays === "number" && Number.isFinite(windowDays)) {
      const recent = db
        .prepare("SELECT DISTINCT date FROM daily WHERE date <= ? ORDER BY date DESC LIMIT ?")
        .all(today, Math.max(1, Math.floor(windowDays))) as Array<{ date: string }>;
      minDate = recent.length ? recent[recent.length - 1].date : "9999-99-99";
    }

    const daily = minDate === "9999-99-99"
      ? []
      : (db
          .prepare(
            `SELECT date, source, metric, ${opts.numericOnly ? "''" : "value_text"} AS text, value_num AS num
             FROM daily WHERE date <= ? AND date >= ? ORDER BY date, source, metric`,
          )
          .all(today, minDate) as { date: string; source: string; metric: string; text: string; num: number | null }[]);

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

    let eventCounts: Array<{
      date: string;
      count: number;
    }> = [];
    try {
      eventCounts = db
        .prepare(
          `SELECT date, COUNT(*) AS count
           FROM events GROUP BY date`,
        )
        .all() as Array<{ date: string; count: number }>;
    } catch {
      eventCounts = [];
    }

    // Column metadata + per-day values.
    const days = new Map<string, JournalDay>();
    const ensure = (date: string): JournalDay => {
      let d = days.get(date);
      if (!d) {
        d = { date, values: {}, memos: [], sessions: [], events: [], eventCount: 0 };
        days.set(date, d);
      }
      return d;
    };

    const colMeta = new Map<string, MetricColumn>();
    for (const c of colRows) {
      const key = `${c.source}.${c.metric}`;
      colMeta.set(key, { key, source: c.source, metric: c.metric, numeric: c.nonNumeric === 0 });
    }
    for (const row of daily) {
      ensure(row.date).values[`${row.source}.${row.metric}`] = { text: row.text, num: row.num };
    }

    for (const s of sessionsRaw) {
      const date = s.date || s.startedAt.slice(0, 10);
      if (!date || date < minDate) continue;
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
      // Scanner notifications are app plumbing, not life captures — they live in
      // the Inbox panel and the Log, never on the Journal as memos.
      if (it.kind === "notification") continue;
      const date = (it.ts || "").slice(0, 10);
      if (!date || date < minDate) continue;
      ensure(date).memos.push({
        id: it.id,
        ts: it.ts,
        source: it.source,
        kind: it.kind,
        text: it.text,
        status: it.status,
      });
    }

    for (const e of eventCounts) {
      if (!e.date || e.date < minDate) continue;
      ensure(e.date).eventCount = e.count;
    }

    const metrics = [...colMeta.values()];
    const ordered = [...days.values()]
      .filter((d) => d.date <= today) // hide future-dated events
      .sort((a, b) => cmp(b.date, a.date)); // newest first

    return { metrics, days: ordered, totalDays: totals.days, totalCells: totals.cells, totalEvents };
  } catch {
    return EMPTY; // stale/older schema
  } finally {
    db.close();
  }
}
