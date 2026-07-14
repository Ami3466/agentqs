import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { detailPath } from "./paths";

/**
 * The SQLite cache is a *derived* store: the git record (plain text files) is
 * the source of truth, this file is a rebuildable index and is never committed.
 * Bump SCHEMA_VERSION whenever the DDL below changes so a stale cache is
 * detectably out of date and gets rebuilt.
 */
export const SCHEMA_VERSION = 3;

/**
 * Full schema. Three record-backed tables (daily / raw_inbox / sessions), a
 * meta table for provenance, and an always-on FTS5 index over free text.
 *
 * `daily` is intentionally long/tidy — (date, source, metric) — not a wide
 * column-per-source table. Sources are open-ended (any dropped CSV can add a
 * metric), so a wide table would need a migration per new metric. Long form
 * absorbs any source with zero schema changes; the UI pivots it back to wide.
 */
export const SCHEMA_SQL = `
CREATE TABLE daily (
  date       TEXT NOT NULL,          -- ISO day, e.g. 2026-07-01
  source     TEXT NOT NULL,          -- record/daily/<source>.csv stem
  metric     TEXT NOT NULL,          -- column name from that CSV
  value_num  REAL,                   -- parsed number when the cell is numeric
  value_text TEXT NOT NULL,          -- raw cell, always kept
  PRIMARY KEY (date, source, metric)
) WITHOUT ROWID;
CREATE INDEX daily_date   ON daily(date);
CREATE INDEX daily_metric ON daily(metric);

CREATE TABLE raw_inbox (
  id     TEXT PRIMARY KEY,           -- stable id from the record line
  ts     TEXT NOT NULL,              -- ISO capture timestamp
  source TEXT NOT NULL,              -- memo | drop | telegram | chat | ...
  kind   TEXT NOT NULL,              -- text | csv | file | ...
  text   TEXT NOT NULL,              -- the raw captured content / description
  meta   TEXT,                       -- JSON blob, source-specific
  status TEXT NOT NULL DEFAULT 'pending'  -- pending | structured | discarded
);
CREATE INDEX raw_inbox_status ON raw_inbox(status);
CREATE INDEX raw_inbox_ts     ON raw_inbox(ts);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  date        TEXT,                  -- day bucket for the Journal timeline
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  skill       TEXT NOT NULL,         -- mentor | therapist | coach | ...
  title       TEXT,
  summary     TEXT,
  transcript  TEXT,                  -- optional full text
  insights    TEXT,                  -- JSON array of strings
  commitments TEXT                   -- JSON array of strings
);
CREATE INDEX sessions_date ON sessions(date);

CREATE TABLE events (
  id     TEXT PRIMARY KEY,
  date   TEXT NOT NULL,              -- ISO day bucket
  ts     TEXT NOT NULL,              -- exact event timestamp when available
  source TEXT NOT NULL,              -- google_myactivity | google_timeline | ...
  title  TEXT,
  text   TEXT NOT NULL,              -- readable event detail
  url    TEXT,
  meta   TEXT                        -- JSON blob, source-specific
);
CREATE INDEX events_date   ON events(date);
CREATE INDEX events_source ON events(source);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Free, always-on keyword search over every text stream (Loop 4 uses this).
CREATE VIRTUAL TABLE search USING fts5(
  ref  UNINDEXED,                    -- 'session:<id>' | 'inbox:<id>' | 'daily:…' | 'event:<id>'
  kind UNINDEXED,                    -- session | inbox | daily | event
  body
);
`;

/**
 * Indexes, kept OUT of SCHEMA_SQL's table DDL on purpose: an index is the one
 * schema change an EXISTING cache can absorb in place (seconds), so it must not
 * ride SCHEMA_VERSION and force a full rebuild (which re-reads the whole record —
 * minutes, and it blocks the server while it runs).
 *
 * `(source, date)` on both fact tables is what "what landed, per source?" needs —
 * the question every Pipeline row asks (`coverageBySource`). With only
 * `events(source)`, SQLite walked the index but still had to fetch all 1.5M rows
 * from the table to read `date` for MIN/MAX — on a real record that is a 1.3GB
 * random-read scan (2.3s warm on an SSD, far worse on a cold container disk), and
 * because better-sqlite3 is SYNCHRONOUS it froze the whole Node thread while it
 * ran. Covering both columns answers the query from the index alone: ~0.15s.
 */
export const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS daily_source_date  ON daily(source, date);
CREATE INDEX IF NOT EXISTS events_source_date ON events(source, date);
`;

export type DB = Database.Database;

const INDEX_NAMES = ["daily_source_date", "events_source_date"];

/** Bring an existing cache's indexes up to date — the migration for everyone whose
 *  DB was built by an older version, so nobody needs a full rebuild to get a
 *  responsive app back.
 *
 *  It asks the file itself (sqlite_master) rather than remembering what it did:
 *  the cache is a FILE THAT GETS REPLACED (rebuild, `backup restore --into-store`,
 *  `migrate-store`), so a "already done it" flag in a long-lived server process
 *  goes stale and silently stops healing. The check is a sub-millisecond read; only
 *  a genuinely missing index costs a write. A write that CAN'T happen (read-only
 *  volume, another process holding the lock) is non-fatal and remembered, so a
 *  hosted replica doesn't retry it on every request — the queries stay correct,
 *  just slower. */
const unfixable = new Set<string>();
export function ensureIndexes(file: string): void {
  if (unfixable.has(file) || !fs.existsSync(file)) return;
  try {
    const ro = new Database(file, { readonly: true, fileMustExist: true });
    let missing: boolean;
    try {
      const have = new Set(
        (ro.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      missing = INDEX_NAMES.some((n) => !have.has(n));
    } finally {
      ro.close();
    }
    if (!missing) return;
    const db = new Database(file);
    try {
      db.exec(INDEX_SQL);
    } finally {
      db.close();
    }
  } catch {
    unfixable.add(file); // can't write here — queryable, just unindexed
  }
}

/** Open (or create) a database at a path with sane pragmas for a local cache. */
export function open(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Open an existing cache read-only — the query path (Data/Journal previews).
 * `query_only` guarantees the derived cache is never mutated by a reader.
 *
 * If a detail store exists next to the cache, attach it as the `detail` schema:
 * every point behind the daily rollups — streams too dense for one row per day
 * (per-minute heart rate, every browser visit) — queryable as
 * `detail.heart_rate` and `detail.chrome_visits`. The same file also answers
 * under the legacy `hires` name so old saved queries keep working.
 */
export function openReadonly(file: string): DB {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  const store = detailPath(path.dirname(file));
  if (fs.existsSync(store)) {
    try {
      db.exec(`ATTACH DATABASE ${sqlString(store)} AS detail`);
      db.exec(`ATTACH DATABASE ${sqlString(store)} AS hires`);
    } catch {
      /* non-fatal: the main record cache is still readable */
    }
  }
  return db;
}

/** Create a fresh in-memory DB with the schema applied — the rebuild target. */
/** Fresh empty cache. With a path, the build is file-backed — SQLite's bounded
 *  page cache instead of the whole DB in RAM, which a million-event record needs;
 *  the file is a scratch build (the caller VACUUMs it into place and deletes it),
 *  so durability pragmas are off. Without a path it stays in memory (tests). */
export function createEmpty(atPath?: string): DB {
  const db = new Database(atPath ?? ":memory:");
  if (atPath) {
    db.pragma("journal_mode = OFF");
    db.pragma("synchronous = OFF");
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  db.exec(SCHEMA_SQL);
  db.exec(INDEX_SQL); // a fresh cache is born indexed; ensureIndexes heals older ones
  return db;
}
