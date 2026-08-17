import fs from "fs";
import { openReadonly, type DB } from "./db";
import { cacheStamp } from "./cache-stamp";
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
  /** Older days exist beyond this page — ask again with `before = oldest`. */
  hasMore: boolean;
  /** The oldest date in THIS page: the cursor for the next one. */
  oldest: string | null;
}

const EMPTY: JournalData = {
  metrics: [],
  days: [],
  totalDays: 0,
  totalCells: 0,
  totalEvents: 0,
  hasMore: false,
  oldest: null,
};

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
  /** Page cursor: return only days STRICTLY OLDER than this date. With `days`, this
   *  is what makes the Journal pageable — the client asks for a screenful, then asks
   *  again from the oldest date it holds. Without it the only way to reach 2015 was
   *  `days=all`, which serializes the entire grid (40MB on a million-cell record)
   *  to show fifty rows. */
  before?: string;
  /** Blank the text of every cell (the Graphs payload — it only reads numbers,
   *  and the text is megabytes of journal writing). */
  numericOnly?: boolean;
}

/**
 * Last payload per (cache file, window, today) — the Journal is the app's heaviest
 * read: on a lifetime record the full-history window pivots ~230k daily rows into
 * megabytes of JSON, and better-sqlite3 is SYNCHRONOUS, so every millisecond of it
 * is a millisecond in which no other request in the process can be served. The
 * Journal and Graphs tabs both ask for it, twice each on a cold load, and it was
 * recomputed every time — that pile-up is what turned a 0.4s query into pages that
 * sat on "Loading…".
 *
 * Keyed on the cache fingerprint, so a write invalidates it the instant it lands,
 * and capped in age so a write the stamp somehow missed self-heals within a minute.
 * Bounded to a handful of entries (the app only ever asks for a few windows) so a
 * long-lived server can't grow a payload cache without limit.
 */
const memo = new Map<string, { stamp: string; at: number; data: JournalData }>();
const MEMO_MAX_AGE_MS = 60_000;
const MEMO_MAX_ENTRIES = 8;

/** The identity of a journal read: same key + same cache stamp → same answer. */
export function journalKey(opts: ReadJournalOptions = {}): string {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return `${opts.file ?? dbPath()}|${opts.days ?? "all"}|${opts.before ?? ""}|${opts.numericOnly ? 1 : 0}|${today}`;
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

  const key = journalKey({ ...opts, file, today });
  const stamp = cacheStamp(file);
  const hit = memo.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < MEMO_MAX_AGE_MS) return hit.data;
  const data = computeJournal({ ...opts, file, today, days: windowDays });
  memo.set(key, { stamp, at: Date.now(), data });
  // Oldest-first eviction — Map preserves insertion order.
  while (memo.size > MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value as string);
  return data;
}

function computeJournal(opts: ReadJournalOptions & { file: string; today: string }): JournalData {
  const { file, today } = opts;
  const windowDays = opts.days ?? "all";
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

    // Resolve the window: the N most recent days with data, older than the cursor.
    // `before` is EXCLUSIVE so paging can't repeat or skip a day at the seam.
    const ceiling = opts.before && opts.before < today ? opts.before : today;
    const exclusive = Boolean(opts.before) && opts.before! <= today;
    const cmpOp = exclusive ? "<" : "<=";
    let minDate = "0000-00-00";
    if (windowDays === 0) minDate = "9999-99-99";
    else if (typeof windowDays === "number" && Number.isFinite(windowDays)) {
      const recent = db
        .prepare(`SELECT DISTINCT date FROM daily WHERE date ${cmpOp} ? ORDER BY date DESC LIMIT ?`)
        .all(ceiling, Math.max(1, Math.floor(windowDays))) as Array<{ date: string }>;
      minDate = recent.length ? recent[recent.length - 1].date : "9999-99-99";
    }

    const daily = minDate === "9999-99-99"
      ? []
      : (db
          .prepare(
            `SELECT date, source, metric, ${opts.numericOnly ? "''" : "value_text"} AS text, value_num AS num
             FROM daily WHERE date ${cmpOp} ? AND date >= ? ORDER BY date, source, metric`,
          )
          .all(ceiling, minDate) as { date: string; source: string; metric: string; text: string; num: number | null }[]);

    // Is there anything older than this page? One indexed lookup, not a count.
    const hasMore =
      minDate === "9999-99-99" || minDate === "0000-00-00"
        ? false
        : Boolean(db.prepare("SELECT 1 FROM daily WHERE date < ? LIMIT 1").get(minDate));

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

    // Same predicate the JS loops below used to apply after the fact: date >= minDate,
    // plus date < ceiling when the page is exclusive. days=0 (minDate "9999-99-99")
    // needs none of these rows — the JS loop discarded every one of them anyway.
    const inboxRaw =
      minDate === "9999-99-99"
        ? []
        : ((exclusive
            ? db
                .prepare(
                  `SELECT id, ts, source, kind, text, status
                   FROM raw_inbox
                   WHERE status != 'discarded' AND kind != 'notification'
                     AND substr(ts, 1, 10) >= ? AND substr(ts, 1, 10) < ?
                   ORDER BY ts`,
                )
                .all(minDate, ceiling)
            : db
                .prepare(
                  `SELECT id, ts, source, kind, text, status
                   FROM raw_inbox
                   WHERE status != 'discarded' AND kind != 'notification'
                     AND substr(ts, 1, 10) >= ?
                   ORDER BY ts`,
                )
                .all(minDate)) as {
            id: string;
            ts: string;
            source: string;
            kind: string;
            text: string;
            status: string;
          }[]);

    let eventCounts: Array<{
      date: string;
      count: number;
    }> = [];
    if (minDate !== "9999-99-99") {
      try {
        eventCounts = (
          exclusive
            ? db
                .prepare(`SELECT date, COUNT(*) AS count FROM events WHERE date >= ? AND date < ? GROUP BY date`)
                .all(minDate, ceiling)
            : db
                .prepare(`SELECT date, COUNT(*) AS count FROM events WHERE date >= ? GROUP BY date`)
                .all(minDate)
        ) as Array<{ date: string; count: number }>;
      } catch {
        eventCounts = [];
      }
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
      if (!date || date < minDate || (exclusive && date >= ceiling)) continue;
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
      // the Inbox panel and the Log, never on the Journal as memos. Both this and
      // the date window are now applied in SQL (see inboxRaw above).
      const date = (it.ts || "").slice(0, 10);
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
      ensure(e.date).eventCount = e.count;
    }

    const metrics = [...colMeta.values()];
    const ordered = [...days.values()]
      .filter((d) => d.date <= today) // hide future-dated events
      .sort((a, b) => cmp(b.date, a.date)); // newest first

    return {
      metrics,
      days: ordered,
      totalDays: totals.days,
      totalCells: totals.cells,
      totalEvents,
      hasMore,
      oldest: ordered.length ? ordered[ordered.length - 1].date : null,
    };
  } catch {
    return EMPTY; // stale/older schema
  } finally {
    db.close();
  }
}
