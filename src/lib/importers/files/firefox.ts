import fs from "fs";
import os from "os";
import path from "path";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";
import { hostOf } from "./chrome";

/**
 * Firefox browsing history — a Tier-2 file importer, sibling of Chrome. Firefox
 * stores history in `places.sqlite`: `moz_places` (url) joined to
 * `moz_historyvisits` (visit_date). Its `visit_date` is MICROSECONDS since the
 * Unix epoch (not Chrome's WebKit epoch). We read a date window and roll it up
 * into the same per-day shape as Chrome:
 *
 *   date, visits, pages (distinct URLs), domains (distinct hosts)
 *
 * Firefox keeps `places.sqlite` open (WAL), so we copy it (plus any -wal/-shm
 * sidecars) to a temp dir and open the copy read-only. Deterministic given the
 * same DB + window.
 */

interface VisitRow {
  t: number; // microseconds since the Unix epoch
  url: string;
}

export function firefoxUsToDay(us: number): string {
  return new Date(Math.floor(us / 1000)).toISOString().slice(0, 10);
}

/** Roll raw (visit_date, url) rows up into the wide per-day daily table. */
export function normalizeFirefoxVisits(rows: VisitRow[], from: string, to: string): DailyTable {
  const header = ["date", "visits", "pages", "domains"];
  const perDay = new Map<string, { visits: number; pages: Set<string>; domains: Set<string> }>();
  for (const r of rows) {
    const day = firefoxUsToDay(r.t);
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

/** Copy the (possibly locked) places.sqlite to a temp dir and open it read-only. */
async function openPlacesCopy(src: string) {
  if (!fs.existsSync(src)) throw new Error(`Firefox places.sqlite not found at ${src}`);
  const { default: Database } = await import("better-sqlite3");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-firefox-"));
  const dest = path.join(tmpDir, "places.sqlite");
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
    throw new Error(`${src} is not a readable Firefox places DB (${(e as Error).message})`);
  }
}

export async function readFirefoxHistory(
  file: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const { db, cleanup } = await openPlacesCopy(file);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('moz_places','moz_historyvisits')")
      .all() as Array<{ name: string }>;
    if (tables.length < 2) {
      throw new Error("expected Firefox 'moz_places' + 'moz_historyvisits' tables (is this a places.sqlite?)");
    }
    const fromUs = Date.parse(`${from}T00:00:00Z`) * 1000;
    const toUs = (Date.parse(`${to}T00:00:00Z`) + 86_400_000) * 1000; // exclusive end of `to`
    const rows = db
      .prepare(
        `SELECT v.visit_date AS t, p.url AS url
         FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
         WHERE v.visit_date >= ? AND v.visit_date < ?`,
      )
      .all(fromUs, toUs) as VisitRow[];
    const table = normalizeFirefoxVisits(rows, from, to);
    return { table, meta: { visitsScanned: rows.length, daysWithData: table.rows.length } };
  } finally {
    db.close();
    cleanup();
  }
}

/** Firefox profiles have random-suffixed dir names, so enumerate the Profiles dir. */
function firefoxDefaultPaths(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (process.platform === "darwin") {
    roots.push(path.join(home, "Library/Application Support/Firefox/Profiles"));
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData/Roaming");
    roots.push(path.join(appData, "Mozilla/Firefox/Profiles"));
  } else {
    roots.push(path.join(home, ".mozilla/firefox"));
  }
  const paths: string[] = [];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        const cand = path.join(root, name, "places.sqlite");
        if (fs.existsSync(cand)) paths.push(cand);
      }
    } catch {
      /* profile root missing — skip */
    }
  }
  paths.push("/host/firefox/places.sqlite"); // Docker: mount your profile at /host/firefox:ro
  return paths;
}

export const firefoxImporter: FileImporter = {
  id: "firefox",
  name: "Firefox history",
  detail: "browsing history · visits, pages, domains per day",
  connectHint: "Reads places.sqlite from your Firefox profile. Run it on the machine Firefox lives on.",
  live: true,
  primaryMetric: "visits",
  unit: "visits",
  defaultPaths: firefoxDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readFirefoxHistory(ctx.path, ctx.from, ctx.to);
  },
};
