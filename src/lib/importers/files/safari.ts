import os from "os";
import path from "path";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";
import { normalizeVisits, openSqliteCopy } from "./chrome";

/**
 * Safari browsing history — a Tier-2 file importer. Safari stores history as a
 * SQLite database (`~/Library/Safari/History.db`) with `history_items` (urls)
 * and `history_visits`; each visit's `visit_time` is a Mac absolute timestamp:
 * seconds since 2001-01-01 UTC, not the Unix epoch. Rolled up into the same
 * per-day table as Chrome:
 *
 *   date, visits, pages (distinct URLs), domains (distinct hosts)
 *
 * The live DB is WAL-locked while Safari runs, so we copy-and-open read-only,
 * exactly like the Chrome importer. macOS gates ~/Library/Safari behind Full
 * Disk Access — a permission error means grant the terminal FDA, not a bug.
 */

// Seconds between the Unix epoch and the Mac absolute epoch (2001-01-01 UTC).
const MAC_EPOCH_OFFSET_S = 978_307_200;

export function macAbsoluteToUnixMs(s: number): number {
  return Math.round((s + MAC_EPOCH_OFFSET_S) * 1000);
}

/** Read a date window out of a Safari History.db file. */
export async function readSafariHistory(
  file: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const { db, cleanup } = await openSqliteCopy(file, "Safari History");
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('history_items','history_visits')")
      .all() as Array<{ name: string }>;
    if (tables.length < 2) {
      throw new Error("expected Safari 'history_items' + 'history_visits' tables (is this a History.db file?)");
    }
    // Bound the scan to the window in the DB's own Mac-absolute seconds.
    const fromS = Date.parse(`${from}T00:00:00Z`) / 1000 - MAC_EPOCH_OFFSET_S;
    const toS = (Date.parse(`${to}T00:00:00Z`) + 86_400_000) / 1000 - MAC_EPOCH_OFFSET_S; // exclusive end of `to`
    const rows = db
      .prepare(
        `SELECT v.visit_time AS t, i.url AS url
         FROM history_visits v JOIN history_items i ON i.id = v.history_item
         WHERE v.visit_time >= ? AND v.visit_time < ?`,
      )
      .all(fromS, toS) as Array<{ t: number; url: string }>;
    const table = normalizeVisits(rows, from, to, macAbsoluteToUnixMs);
    return {
      table,
      meta: { visitsScanned: rows.length, daysWithData: table.rows.length },
    };
  } finally {
    db.close();
    cleanup();
  }
}

function safariDefaultPaths(): string[] {
  const paths: string[] = [];
  if (process.platform === "darwin") {
    paths.push(path.join(os.homedir(), "Library/Safari/History.db"));
  }
  // Docker: the compose file can mount the Safari dir at /host/safari:ro.
  paths.push("/host/safari/History.db");
  return paths;
}

export const safariImporter: FileImporter = {
  id: "safari",
  name: "Safari history",
  detail: "browsing history · local History.db (needs Full Disk Access)",
  live: true,
  primaryMetric: "visits",
  unit: "visits",
  defaultPaths: safariDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readSafariHistory(ctx.path, ctx.from, ctx.to);
  },
};
