import fs from "fs";
import os from "os";
import path from "path";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";
import { hostOf } from "./chrome";

/**
 * Safari browsing history — a Tier-2 file importer, sibling of Chrome/Firefox.
 * Safari stores history in `History.db`: `history_items` (url) joined to
 * `history_visits` (visit_time). Its `visit_time` is a Core Foundation absolute
 * time — SECONDS since 2001-01-01 UTC — so we shift by the CF↔Unix offset. Rolls
 * up into the same per-day shape:
 *
 *   date, visits, pages (distinct URLs), domains (distinct hosts)
 *
 * `~/Library/Safari` needs Full Disk Access; the reader copies the (WAL-locked)
 * DB to a temp dir and opens the copy read-only. Deterministic given DB + window.
 */

// Seconds between the Unix epoch (1970) and the CF absolute-time epoch (2001-01-01).
const CF_EPOCH_OFFSET_S = 978_307_200;

interface VisitRow {
  t: number; // CF absolute time (seconds since 2001-01-01)
  url: string;
}

export function cfTimeToDay(s: number): string {
  return new Date((s + CF_EPOCH_OFFSET_S) * 1000).toISOString().slice(0, 10);
}

/** Roll raw (visit_time, url) rows up into the wide per-day daily table. */
export function normalizeSafariVisits(rows: VisitRow[], from: string, to: string): DailyTable {
  const header = ["date", "visits", "pages", "domains"];
  const perDay = new Map<string, { visits: number; pages: Set<string>; domains: Set<string> }>();
  for (const r of rows) {
    const day = cfTimeToDay(r.t);
    if (day < from || day > to) continue;
    const bucket = perDay.get(day) ?? { visits: 0, pages: new Set<string>(), domains: new Set<string>() };
    bucket.visits += 1;
    bucket.pages.add(r.url);
    const host = hostOf(r.url);
    if (host) bucket.domains.add(host);
    perDay.set(day, bucket);
  }
  const rowsOut = [...perDay.keys()].sort().map((day) => {
    const b = perDay.get(day)!;
    return [day, String(b.visits), String(b.pages.size), String(b.domains.size)];
  });
  return { header, rows: rowsOut };
}

async function openHistoryCopy(src: string) {
  if (!fs.existsSync(src)) throw new Error(`Safari History.db not found at ${src}`);
  const { default: Database } = await import("better-sqlite3");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-safari-"));
  const dest = path.join(tmpDir, "History.db");
  fs.copyFileSync(src, dest);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, dest + ext);
  }
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  try {
    return { db: new Database(dest, { readonly: true, fileMustExist: true }), cleanup };
  } catch (e) {
    cleanup();
    throw new Error(`${src} is not a readable Safari History DB (${(e as Error).message})`);
  }
}

export async function readSafariHistory(
  file: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const { db, cleanup } = await openHistoryCopy(file);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('history_items','history_visits')")
      .all() as Array<{ name: string }>;
    if (tables.length < 2) {
      throw new Error("expected Safari 'history_items' + 'history_visits' tables (is this a History.db?)");
    }
    const fromS = Date.parse(`${from}T00:00:00Z`) / 1000 - CF_EPOCH_OFFSET_S;
    const toS = (Date.parse(`${to}T00:00:00Z`) + 86_400_000) / 1000 - CF_EPOCH_OFFSET_S; // exclusive
    const rows = db
      .prepare(
        `SELECT v.visit_time AS t, i.url AS url
         FROM history_visits v JOIN history_items i ON i.id = v.history_item
         WHERE v.visit_time >= ? AND v.visit_time < ?`,
      )
      .all(fromS, toS) as VisitRow[];
    const table = normalizeSafariVisits(rows, from, to);
    return { table, meta: { visitsScanned: rows.length, daysWithData: table.rows.length } };
  } finally {
    db.close();
    cleanup();
  }
}

function safariDefaultPaths(): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  if (process.platform === "darwin") paths.push(path.join(home, "Library/Safari/History.db"));
  paths.push("/host/safari/History.db"); // Docker: mount ~/Library/Safari at /host/safari:ro
  return paths;
}

export const safariImporter: FileImporter = {
  id: "safari",
  name: "Safari history",
  detail: "browsing history · visits, pages, domains per day",
  connectHint: "Reads ~/Library/Safari/History.db (needs Full Disk Access for your terminal).",
  live: true,
  primaryMetric: "visits",
  unit: "visits",
  defaultPaths: safariDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readSafariHistory(ctx.path, ctx.from, ctx.to);
  },
};
