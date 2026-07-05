import fs from "fs";
import os from "os";
import path from "path";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * Chrome / Chromium browsing history — a Tier-2 file importer. Chrome stores its
 * history as a SQLite database (`History`) with a `urls` table and a `visits`
 * table; each visit's `visit_time` is a WebKit/Chrome timestamp: microseconds
 * since 1601-01-01 UTC, not the Unix epoch. We read a date window and roll it up
 * into a per-day table:
 *
 *   date, visits, pages (distinct URLs), domains (distinct hosts)
 *
 * Chrome keeps the live `History` file open (WAL), so we copy it (plus any
 * `-wal`/`-shm` sidecars) to a temp dir and open the copy read-only — never touch
 * the browser's own file. Deterministic given the same DB + window.
 */

// Milliseconds between the WebKit epoch (1601-01-01) and the Unix epoch.
const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;

export function webkitToUnixMs(us: number): number {
  return Math.floor(us / 1000) - WEBKIT_EPOCH_OFFSET_MS;
}
export function unixMsToWebkit(ms: number): number {
  return (ms + WEBKIT_EPOCH_OFFSET_MS) * 1000;
}

/** Host of a URL, lower-cased, `www.` stripped; "" when it can't be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

interface VisitRow {
  t: number; // WebKit microseconds
  url: string;
}

/** Roll raw (visit_time, url) rows up into the wide per-day daily table. */
export function normalizeChromeVisits(rows: VisitRow[], from: string, to: string): DailyTable {
  const header = ["date", "visits", "pages", "domains"];
  const fromDay = from;
  const toDay = to;
  const perDay = new Map<string, { visits: number; pages: Set<string>; domains: Set<string> }>();
  for (const r of rows) {
    const day = new Date(webkitToUnixMs(r.t)).toISOString().slice(0, 10);
    if (day < fromDay || day > toDay) continue;
    const bucket =
      perDay.get(day) ?? { visits: 0, pages: new Set<string>(), domains: new Set<string>() };
    bucket.visits += 1;
    bucket.pages.add(r.url);
    const host = hostOf(r.url);
    if (host) bucket.domains.add(host);
    perDay.set(day, bucket);
  }
  const outRows = [...perDay.keys()]
    .sort()
    .map((day) => {
      const b = perDay.get(day)!;
      return [day, String(b.visits), String(b.pages.size), String(b.domains.size)];
    });
  return { header, rows: outRows };
}

/** Copy the (possibly locked) History DB to a temp dir and open it read-only. */
async function openHistoryCopy(src: string) {
  if (!fs.existsSync(src)) {
    throw new Error(`Chrome History file not found at ${src}`);
  }
  const { default: Database } = await import("better-sqlite3");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-chrome-"));
  const dest = path.join(tmpDir, "History");
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
    const db = new Database(dest, { readonly: true, fileMustExist: true });
    return { db, cleanup };
  } catch (e) {
    cleanup();
    throw new Error(`${src} is not a readable Chrome History database (${(e as Error).message})`);
  }
}

/** Read a date window out of a Chrome History SQLite file. */
export async function readChromeHistory(
  file: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const { db, cleanup } = await openHistoryCopy(file);
  try {
    const hasVisits = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('visits','urls')")
      .all() as Array<{ name: string }>;
    if (hasVisits.length < 2) {
      throw new Error("expected Chrome 'urls' + 'visits' tables (is this a History file?)");
    }
    // Bound the scan to the window in the DB's own WebKit-microsecond units.
    const fromUs = unixMsToWebkit(Date.parse(`${from}T00:00:00Z`));
    const toUs = unixMsToWebkit(Date.parse(`${to}T00:00:00Z`) + 86_400_000); // exclusive end of `to`
    const rows = db
      .prepare(
        `SELECT v.visit_time AS t, u.url AS url
         FROM visits v JOIN urls u ON u.id = v.url
         WHERE v.visit_time >= ? AND v.visit_time < ?`,
      )
      .all(fromUs, toUs) as VisitRow[];
    const table = normalizeChromeVisits(rows, from, to);
    return {
      table,
      meta: { visitsScanned: rows.length, daysWithData: table.rows.length },
    };
  } finally {
    db.close();
    cleanup();
  }
}

/** Default `History` locations across platforms + the Docker read-only mount. */
function chromeDefaultPaths(): string[] {
  const home = os.homedir();
  const platform = process.platform;
  const paths: string[] = [];
  if (platform === "darwin") {
    paths.push(
      path.join(home, "Library/Application Support/Google/Chrome/Default/History"),
      path.join(home, "Library/Application Support/Chromium/Default/History"),
      path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default/History"),
    );
  } else if (platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData/Local");
    paths.push(path.join(local, "Google/Chrome/User Data/Default/History"));
  } else {
    paths.push(
      path.join(home, ".config/google-chrome/Default/History"),
      path.join(home, ".config/chromium/Default/History"),
    );
  }
  // Docker: the compose file mounts the Chrome profile dir at /host/chrome:ro.
  paths.push("/host/chrome/Default/History");
  return paths;
}

export const chromeImporter: FileImporter = {
  id: "chrome",
  name: "Chrome history",
  detail: "browsing history · visits, pages, domains per day",
  connectHint: "Reads Chrome/Chromium/Brave's local History DB. Run it where the browser lives.",
  live: true,
  primaryMetric: "visits",
  unit: "visits",
  defaultPaths: chromeDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readChromeHistory(ctx.path, ctx.from, ctx.to);
  },
};
