#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 12 · Local daemon + file importers.
 *
 *   MAIN: a Chrome-history import COMMAND reads a local History file and lands
 *   rows in the record. We synthesize a real Chrome History SQLite (urls +
 *   visits, WebKit-microsecond timestamps), run the actual `import:file` CLI
 *   against it (--rebuild), and assert the rows appear in record/daily/chrome.csv
 *   and in the rebuilt daily table with the right per-day counts.
 *
 *   Also exercised: the iPhone-backup stub reads a Manifest.db and lands a
 *   snapshot row; and `daemon sync` commits the record repo (git = the sync layer
 *   a cloud replica pulls from).
 *
 * Drives production code end to end via the CLIs — no network. Run: npm run files:test
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { unixMsToWebkit } from "../src/lib/importers/files/chrome";

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

/** Run a repo CLI with tsx, capture stdout (scripts print only JSON with --json). */
function runCli(script: string, args: string[]): string {
  return execFileSync(TSX, [path.join("scripts", script), ...args], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Build a synthetic Chrome `History` SQLite with a few dated visits. */
function seedChromeHistory(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY, url TEXT, title TEXT,
      visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER
    );
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER,
      from_visit INTEGER, transition INTEGER, segment_id INTEGER, visit_duration INTEGER
    );
  `);
  const urls = [
    [1, "https://github.com/a/pull/1"],
    [2, "https://github.com/a/pull/2"],
    [3, "https://news.ycombinator.com/item?id=1"],
    [4, "https://github.com/b/issues/9"],
    [5, "https://www.google.com/search?q=x"],
    [6, "https://example.com/old-visit-outside-window"],
  ] as const;
  const insUrl = db.prepare("INSERT INTO urls (id,url,visit_count) VALUES (?,?,1)");
  for (const [id, url] of urls) insUrl.run(id, url);

  const wk = (iso: string) => unixMsToWebkit(Date.parse(iso));
  const visits: Array<[number, string]> = [
    // 2026-06-10 → 3 visits, 3 pages, 2 domains
    [1, "2026-06-10T12:00:00Z"],
    [2, "2026-06-10T13:00:00Z"],
    [3, "2026-06-10T14:00:00Z"],
    // 2026-06-11 → 2 visits, 1 page, 1 domain
    [4, "2026-06-11T09:00:00Z"],
    [4, "2026-06-11T18:00:00Z"],
    // 2026-06-12 → 1 visit, 1 page, 1 domain
    [5, "2026-06-12T10:00:00Z"],
    // outside the import window — must be filtered out
    [6, "2026-05-01T12:00:00Z"],
  ];
  const insVisit = db.prepare("INSERT INTO visits (url,visit_time,transition) VALUES (?,?,0)");
  for (const [urlId, iso] of visits) insVisit.run(urlId, wk(iso));
  db.close();
}

/** Build a minimal iOS backup: Manifest.db (Files table) + Info.plist. */
function seedIphoneBackup(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "Manifest.db"));
  db.exec(
    "CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)",
  );
  const rows: Array<[string, string, string]> = [
    ["f1", "HomeDomain", "Library/SMS/sms.db"],
    ["f2", "HomeDomain", "Library/Preferences/x.plist"],
    ["f3", "HomeDomain", "Library/CallHistoryDB/CallHistory.storedata"],
    ["f4", "CameraRollDomain", "Media/DCIM/100APPLE/IMG_0001.JPG"],
    ["f5", "CameraRollDomain", "Media/DCIM/100APPLE/IMG_0002.JPG"],
    ["f6", "AppDomain-com.foo.bar", "Documents/data.sqlite"],
  ];
  const ins = db.prepare("INSERT INTO Files (fileID,domain,relativePath,flags) VALUES (?,?,?,1)");
  for (const [id, domain, rel] of rows) ins.run(id, domain, rel);
  db.close();
  fs.writeFileSync(
    path.join(dir, "Info.plist"),
    `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>Last Backup Date</key><date>2026-06-15T09:00:00Z</date>\n<key>Device Name</key><string>Test iPhone</string>\n</dict></plist>\n`,
  );
}

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-files-"));
  const recordDir = path.join(root, "record");
  const dbFile = path.join(root, "agentqs.db");
  const history = path.join(root, "History");
  const from = "2026-06-01";
  const to = "2026-06-30";

  console.log("\nLoop 12 — local file importers\n");

  // ---- Ships-when: the Chrome import command ------------------------------
  console.log("Chrome history → import:file command → record");
  seedChromeHistory(history);
  check("synthetic Chrome History created", fs.existsSync(history));

  const out = runCli("import-file.ts", [
    "--source", "chrome",
    "--path", history,
    "--record", recordDir,
    "--data", root,
    "--from", from,
    "--to", to,
    "--rebuild",
    "--json",
  ]);
  const res = JSON.parse(out) as {
    metrics: string[];
    cells: number;
    daysWithData: number;
    rebuilt: { source: number; daily: number } | null;
    meta?: { visitsScanned?: number };
  };

  const csv = path.join(recordDir, "daily", "chrome.csv");
  check("record/daily/chrome.csv written", fs.existsSync(csv));
  check(
    "header is date,visits,pages,domains",
    fs.readFileSync(csv, "utf8").split(/\r?\n/)[0] === "date,visits,pages,domains",
  );
  check("3 days landed in the window", res.daysWithData === 3, `${res.daysWithData} days`);
  check("out-of-window visit filtered", res.meta?.visitsScanned === 6, `${res.meta?.visitsScanned} scanned`);
  check("9 daily cells written (3 days × 3 metrics)", res.cells === 9, `${res.cells} cells`);
  check(
    "metrics are visits/pages/domains",
    ["visits", "pages", "domains"].every((m) => res.metrics.includes(m)),
    res.metrics.join(", "),
  );
  check("rebuild landed chrome rows in the daily table", (res.rebuilt?.source ?? 0) === 9, `${res.rebuilt?.source} rows`);

  // Prove the exact per-day counts came through into the rebuilt cache.
  const db = new Database(dbFile, { readonly: true });
  const cell = (date: string, metric: string): number | null => {
    const r = db
      .prepare("SELECT value_num AS n FROM daily WHERE source='chrome' AND date=? AND metric=?")
      .get(date, metric) as { n: number } | undefined;
    return r ? r.n : null;
  };
  check("2026-06-10 → 3 visits, 3 pages, 2 domains",
    cell("2026-06-10", "visits") === 3 && cell("2026-06-10", "pages") === 3 && cell("2026-06-10", "domains") === 2);
  check("2026-06-11 → 2 visits, 1 page, 1 domain",
    cell("2026-06-11", "visits") === 2 && cell("2026-06-11", "pages") === 1 && cell("2026-06-11", "domains") === 1);
  check("2026-06-12 → 1 visit", cell("2026-06-12", "visits") === 1);
  check("no chrome row outside the window", cell("2026-05-01", "visits") === null);
  db.close();

  // ---- iPhone backup stub -------------------------------------------------
  console.log("\niPhone backup (stub) → snapshot row");
  const backup = path.join(root, "MobileSync", "Backup", "00008030-DEVICEUDID");
  seedIphoneBackup(backup);
  const iOut = runCli("import-file.ts", [
    "--source", "iphone",
    "--path", path.join(root, "MobileSync", "Backup"), // pass the Backup ROOT → newest device
    "--record", recordDir,
    "--data", root,
    "--from", from,
    "--to", to,
    "--rebuild",
    "--json",
  ]);
  const iRes = JSON.parse(iOut) as {
    daysWithData: number;
    meta?: { files?: number; domains?: number; backupDay?: string };
  };
  check("backup snapshot day resolved from Info.plist", iRes.meta?.backupDay === "2026-06-15", String(iRes.meta?.backupDay));
  check("manifest read: 6 files across 3 domains", iRes.meta?.files === 6 && iRes.meta?.domains === 3);

  const db2 = new Database(dbFile, { readonly: true });
  const files = db2
    .prepare("SELECT value_num AS n FROM daily WHERE source='iphone' AND date='2026-06-15' AND metric='files_backed_up'")
    .get() as { n: number } | undefined;
  check("iphone snapshot landed in daily table", files?.n === 6, `files_backed_up=${files?.n}`);
  db2.close();

  // ---- daemon sync: git is the sync layer ---------------------------------
  console.log("\ndaemon sync → commit the record repo (git = the sync layer)");
  execFileSync("git", ["-C", recordDir, "init", "-q"], { encoding: "utf8" });
  execFileSync("git", ["-C", recordDir, "config", "user.email", "test@agentqs.local"]);
  execFileSync("git", ["-C", recordDir, "config", "user.name", "agentqs test"]);
  const sOut = runCli("daemon.ts", ["sync", "--record", recordDir, "--json"]);
  const sRes = JSON.parse(sOut) as { committed: boolean; pushed: boolean; repo: string | null };
  check("record committed to its git repo", sRes.committed === true);
  check("not pushed without --push", sRes.pushed === false);
  const log = execFileSync("git", ["-C", recordDir, "log", "--oneline"], { encoding: "utf8" });
  check("commit is in the record repo history", log.trim().length > 0, log.trim().split("\n")[0]);

  fs.rmSync(root, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Loop 12 ships: the Chrome import command reads a local History file and lands rows in the record; the iPhone stub lands a snapshot; daemon sync commits the record for a cloud replica to pull.\n",
  );
}

main();
