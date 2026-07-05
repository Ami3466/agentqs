import Database from "better-sqlite3";

/**
 * The SQLite cache is a *derived* store: the git record (plain text files) is
 * the source of truth, this file is a rebuildable index and is never committed.
 * Bump SCHEMA_VERSION whenever the DDL below changes so a stale cache is
 * detectably out of date and gets rebuilt.
 */
export const SCHEMA_VERSION = 1;

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

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Free, always-on keyword search over every text stream (Loop 4 uses this).
CREATE VIRTUAL TABLE search USING fts5(
  ref  UNINDEXED,                    -- 'session:<id>' | 'inbox:<id>'
  kind UNINDEXED,                    -- session | inbox
  body
);
`;

export type DB = Database.Database;

/** Open (or create) a database at a path with sane pragmas for a local cache. */
export function open(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Create a fresh in-memory DB with the schema applied — the rebuild target. */
export function createEmpty(): DB {
  const db = new Database(":memory:");
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  db.exec(SCHEMA_SQL);
  return db;
}
