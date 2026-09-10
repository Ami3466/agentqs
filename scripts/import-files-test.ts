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
import { unixMsToMacAbsolute } from "../src/lib/importers/files/safari";
import { buildSources } from "../src/lib/source-registry";
import { appendInboxItem, appendInboxItems, captureSummary, readInboxFromRecord, rebuild, updateInboxItems } from "../src/lib/record";
import { MAX_INBOX_BYTES } from "../src/lib/import-tree";
import { inboxResolve } from "../src/lib/cli-core";
import { captureRouteFor, extensionOf, looksImageName, looksTextualName } from "../src/lib/file-kinds";
import { sourceName } from "../src/lib/structure";

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

/** Build a tiny Google Takeout Chrome/BrowserHistory.json export. */
function seedChromeTakeout(file: string): void {
  const unixUs = (iso: string) => Date.parse(iso) * 1000;
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        "Browser History": [
          { url: "https://example.com/a", title: "A", time_usec: unixUs("2020-01-02T08:00:00Z") },
          { url: "https://example.com/b", title: "B", time_usec: String(unixUs("2020-01-02T09:00:00Z")) },
          { url: "https://news.ycombinator.com/item?id=2", title: "HN", time_usec: unixUs("2020-01-03T10:00:00Z") },
          { url: "https://example.com/outside", title: "Old", time_usec: unixUs("2019-12-31T10:00:00Z") },
        ],
      },
      null,
      2,
    ),
  );
}

/** Build a synthetic Safari History.db (Mac-absolute-second timestamps). */
function seedSafariHistory(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
    CREATE TABLE history_visits (
      id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT
    );
  `);
  const insItem = db.prepare("INSERT INTO history_items (id,url,visit_count) VALUES (?,?,1)");
  insItem.run(1, "https://developer.apple.com/docs");
  insItem.run(2, "https://news.ycombinator.com/item?id=3");
  insItem.run(3, "https://example.com/outside-window");
  const mac = (iso: string) => unixMsToMacAbsolute(Date.parse(iso));
  const insVisit = db.prepare("INSERT INTO history_visits (history_item,visit_time) VALUES (?,?)");
  // 2026-06-10 → 2 visits · 2026-06-11 → 1 visit · one out-of-window
  insVisit.run(1, mac("2026-06-10T08:00:00Z"));
  insVisit.run(2, mac("2026-06-10T09:00:00Z"));
  insVisit.run(1, mac("2026-06-11T10:00:00Z"));
  insVisit.run(3, mac("2026-05-01T10:00:00Z"));
  db.close();
}

/** Build a tiny Apple Health export.xml: two devices counting the same steps
 *  (dedup must keep the best, not the sum), HR samples, sleep segments,
 *  locale units (mi/kJ must convert), and a double-logged workout. */
function seedAppleHealth(file: string): void {
  const rec = (type: string, source: string, start: string, end: string, value: string, unit = "count") =>
    `  <Record type="${type}" sourceName="${source}" unit="${unit}" startDate="${start}" endDate="${end}" value="${value}"/>`;
  const workout = (source: string, start: string, end: string) =>
    `  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="${source}" startDate="${start}" endDate="${end}" duration="40"/>`;
  fs.writeFileSync(
    file,
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE HealthData []>`,
      `<HealthData locale="en_IL">`,
      // 2024-05-15 steps: iPhone 4000+3000=7000, Watch 8000 → day keeps 8000
      rec("HKQuantityTypeIdentifierStepCount", "iPhone", "2024-05-15 08:00:00 +0300", "2024-05-15 09:00:00 +0300", "4000"),
      rec("HKQuantityTypeIdentifierStepCount", "iPhone", "2024-05-15 10:00:00 +0300", "2024-05-15 11:00:00 +0300", "3000"),
      rec("HKQuantityTypeIdentifierStepCount", "Watch", "2024-05-15 08:00:00 +0300", "2024-05-15 20:00:00 +0300", "8000"),
      rec("HKQuantityTypeIdentifierDistanceWalkingRunning", "Watch", "2024-05-15 08:00:00 +0300", "2024-05-15 20:00:00 +0300", "6.4"),
      rec("HKQuantityTypeIdentifierHeartRate", "Watch", "2024-05-15 08:00:00 +0300", "2024-05-15 08:00:00 +0300", "60"),
      rec("HKQuantityTypeIdentifierHeartRate", "Watch", "2024-05-15 09:00:00 +0300", "2024-05-15 09:00:00 +0300", "80"),
      // 2024-05-16 sleep: two Asleep segments (60 + 30) + one InBed that must NOT count
      rec("HKCategoryTypeIdentifierSleepAnalysis", "Watch", "2024-05-15 23:30:00 +0300", "2024-05-16 00:30:00 +0300", "HKCategoryValueSleepAnalysisAsleepCore"),
      rec("HKCategoryTypeIdentifierSleepAnalysis", "Watch", "2024-05-16 00:30:00 +0300", "2024-05-16 01:00:00 +0300", "HKCategoryValueSleepAnalysisAsleepREM"),
      rec("HKCategoryTypeIdentifierSleepAnalysis", "Watch", "2024-05-15 23:00:00 +0300", "2024-05-16 01:10:00 +0300", "HKCategoryValueSleepAnalysisInBed"),
      // 2024-05-17 locale units: a US phone exports mi and kJ — both must convert
      rec("HKQuantityTypeIdentifierDistanceWalkingRunning", "iPhone", "2024-05-17 08:00:00 +0300", "2024-05-17 09:00:00 +0300", "2", "mi"),
      rec("HKQuantityTypeIdentifierActiveEnergyBurned", "iPhone", "2024-05-17 08:00:00 +0300", "2024-05-17 09:00:00 +0300", "1000", "kJ"),
      // out-of-window record must be filtered by from/to
      rec("HKQuantityTypeIdentifierStepCount", "iPhone", "2023-01-01 08:00:00 +0200", "2023-01-01 09:00:00 +0200", "999"),
      // the same evening run logged by the Watch AND Strava (overlap → 1),
      // plus a separate morning run → the day holds 2 workouts, not 3
      workout("Watch", "2024-05-15 18:00:00 +0300", "2024-05-15 18:40:00 +0300"),
      workout("Strava", "2024-05-15 18:01:00 +0300", "2024-05-15 18:39:00 +0300"),
      workout("Watch", "2024-05-15 06:00:00 +0300", "2024-05-15 06:30:00 +0300"),
      `</HealthData>`,
    ].join("\n"),
  );
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
  const takeout = path.join(root, "BrowserHistory.json");
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

  // ---- Google Takeout Chrome history --------------------------------------
  console.log("\nChrome Google Takeout JSON → import:file command → record");
  seedChromeTakeout(takeout);
  const tOut = runCli("import-file.ts", [
    "--source", "chrome",
    "--path", takeout,
    "--record", recordDir,
    "--data", root,
    "--from", "2020-01-01",
    "--to", "2020-01-31",
    "--rebuild",
    "--json",
  ]);
  const tRes = JSON.parse(tOut) as {
    cells: number;
    daysWithData: number;
    meta?: { visitsScanned?: number; format?: string };
  };
  check("Takeout JSON detected", tRes.meta?.format === "takeout-json", String(tRes.meta?.format));
  check("Takeout imports all in-window years when requested", tRes.daysWithData === 2, `${tRes.daysWithData} days`);
  check("Takeout JSON unix-microsecond timestamps parsed", tRes.cells === 6, `${tRes.cells} cells`);

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

  // ---- Safari history -----------------------------------------------------
  console.log("\nSafari History.db → import:file command → record");
  const safariDb = path.join(root, "History.db");
  seedSafariHistory(safariDb);
  const sfOut = runCli("import-file.ts", [
    "--source", "safari",
    "--path", safariDb,
    "--record", recordDir,
    "--data", root,
    "--from", from,
    "--to", to,
    "--rebuild",
    "--json",
  ]);
  const sfRes = JSON.parse(sfOut) as { cells: number; daysWithData: number; meta?: { visitsScanned?: number } };
  const safariCsv = path.join(recordDir, "daily", "safari.csv");
  check("record/daily/safari.csv written", fs.existsSync(safariCsv));
  check(
    "same columns as Chrome (date,visits,pages,domains)",
    fs.readFileSync(safariCsv, "utf8").split(/\r?\n/)[0] === "date,visits,pages,domains",
  );
  check("2 days landed, out-of-window visit excluded by the bounded scan", sfRes.daysWithData === 2 && sfRes.meta?.visitsScanned === 3, `${sfRes.daysWithData} days, ${sfRes.meta?.visitsScanned} scanned`);

  // ---- Apple Health export ------------------------------------------------
  console.log("\nApple Health export.xml → health_daily backfill");
  const healthXml = path.join(root, "export.xml");
  seedAppleHealth(healthXml);
  const ahOut = runCli("import-file.ts", [
    "--source", "health_daily",
    "--path", healthXml,
    "--record", recordDir,
    "--data", root,
    "--from", "2024-05-01",
    "--to", "2024-05-31",
    "--rebuild",
    "--json",
  ]);
  const ahRes = JSON.parse(ahOut) as { cells: number; daysWithData: number; metrics: string[] };
  check("3 days landed", ahRes.daysWithData === 3, `${ahRes.daysWithData} days`);
  check(
    "metrics match the existing health_daily columns",
    ["steps", "distance_km", "asleep_min", "hr_avg", "workouts", "active_energy_kcal"].every((m) => ahRes.metrics.includes(m)),
    ahRes.metrics.join(", "),
  );
  const db3 = new Database(dbFile, { readonly: true });
  const steps = db3
    .prepare("SELECT value_num AS n FROM daily WHERE source='health_daily' AND date='2024-05-15' AND metric='steps'")
    .get() as { n: number } | undefined;
  // iPhone logged 4000+3000, Watch logged 8000 → the day keeps its best device, never the double-counted sum.
  check("device dedup: best source wins (8000), not the cross-device sum", steps?.n === 8000, `steps=${steps?.n}`);
  const sleep = db3
    .prepare("SELECT value_num AS n FROM daily WHERE source='health_daily' AND date='2024-05-16' AND metric='asleep_min'")
    .get() as { n: number } | undefined;
  check("sleep minutes summed from Asleep segments only (90)", sleep?.n === 90, `asleep_min=${sleep?.n}`);
  const dist = db3
    .prepare("SELECT value_num AS n FROM daily WHERE source='health_daily' AND date='2024-05-17' AND metric='distance_km'")
    .get() as { n: number } | undefined;
  check("locale units: 2 mi lands as 3.22 km, not 2", dist?.n === 3.22, `distance_km=${dist?.n}`);
  const energy = db3
    .prepare("SELECT value_num AS n FROM daily WHERE source='health_daily' AND date='2024-05-17' AND metric='active_energy_kcal'")
    .get() as { n: number } | undefined;
  check("locale units: 1000 kJ lands as 239 kcal", energy?.n === 239, `active_energy_kcal=${energy?.n}`);
  const workouts = db3
    .prepare("SELECT value_num AS n FROM daily WHERE source='health_daily' AND date='2024-05-15' AND metric='workouts'")
    .get() as { n: number } | undefined;
  check("workout dedup: Watch+Strava same run counts once (2 workouts, not 3)", workouts?.n === 2, `workouts=${workouts?.n}`);
  db3.close();

  // ---- Spotify export ------------------------------------------------------
  // The API serves ~50 plays and takes no date range, so `spotify` could only ever
  // show a few days — the record said a lifetime of listening began last Tuesday.
  // The export is where the history actually is, and it lands in the SAME source, so
  // one Spotify row covers years and the sync keeps its recent end fresh.
  console.log("\nSpotify export → the `spotify` source the API sync keeps fresh");
  const spotifyDir = path.join(root, "my_spotify_data");
  fs.mkdirSync(spotifyDir, { recursive: true });
  // Extended export: ISO `ts`, ms_played — with a podcast episode and a 0ms skip
  // mixed in, exactly as Spotify ships them.
  fs.writeFileSync(
    path.join(spotifyDir, "Streaming_History_Audio_2019-2020_0.json"),
    JSON.stringify([
      { ts: "2019-04-02T08:00:00Z", ms_played: 180_000, master_metadata_track_name: "A", spotify_track_uri: "spotify:track:a" },
      { ts: "2019-04-02T08:05:00Z", ms_played: 240_000, master_metadata_track_name: "B", spotify_track_uri: "spotify:track:b" },
      { ts: "2019-04-02T09:00:00Z", ms_played: 0, master_metadata_track_name: "C", spotify_track_uri: "spotify:track:c" },
      { ts: "2019-04-02T10:00:00Z", ms_played: 900_000, episode_name: "Pod", spotify_episode_uri: "spotify:episode:z" },
      { ts: "2020-11-30T21:00:00Z", ms_played: 300_000, master_metadata_track_name: "D", spotify_track_uri: "spotify:track:d" },
    ]),
  );
  // Account-data export: the older shape, local "endTime" + msPlayed. Both parse.
  fs.writeFileSync(
    path.join(spotifyDir, "StreamingHistory0.json"),
    JSON.stringify([{ endTime: "2024-02-09 23:12", artistName: "X", trackName: "E", msPlayed: 120_000 }]),
  );
  const spOut = runCli("import-file.ts", [
    "--source", "spotify",
    "--path", spotifyDir,
    "--record", recordDir,
    "--data", root,
    "--rebuild",
    "--json",
  ]);
  const spRes = JSON.parse(spOut) as { daysWithData: number; metrics: string[]; meta?: { plays?: number; files?: number } };
  check("both export shapes parse (extended + account data)", spRes.meta?.files === 2, `${spRes.meta?.files} files`);
  check("3 days landed across 5 years", spRes.daysWithData === 3, `${spRes.daysWithData} days`);
  check(
    "it writes the API sync's own columns, so they are ONE history",
    JSON.stringify(spRes.metrics.sort()) === JSON.stringify(["minutes", "tracks"]),
    spRes.metrics.join(", "),
  );
  const spCsv = fs.readFileSync(path.join(recordDir, "daily", "spotify.csv"), "utf8");
  check(
    "it lands in daily/spotify.csv — not a stranger called spotify_history",
    spCsv.split("\n")[1]?.startsWith("2019-04-02"),
    spCsv.split("\n")[1],
  );
  const db4 = new Database(dbFile, { readonly: true });
  const spTracks = db4
    .prepare("SELECT value_num AS n FROM daily WHERE source='spotify' AND date='2019-04-02' AND metric='tracks'")
    .get() as { n: number } | undefined;
  // 2 real plays. The podcast episode is not a track, and a 0ms skip is not listening.
  check("podcast episodes and 0ms skips are not tracks", spTracks?.n === 2, `tracks=${spTracks?.n}`);
  const spMins = db4
    .prepare("SELECT value_num AS n FROM daily WHERE source='spotify' AND date='2019-04-02' AND metric='minutes'")
    .get() as { n: number } | undefined;
  check("minutes come from ms_played (180s + 240s = 7)", spMins?.n === 7, `minutes=${spMins?.n}`);
  db4.close();
  // The whole point: ONE Spotify, showing the lifetime — not a live source with 3
  // days sitting next to a file source with the years. Point the store at the temp
  // dir first: coverage is read from the cache, and this must never touch the real one.
  process.env.AGENTQS_DATA_DIR = root;
  const spotifyRows = buildSources(null, recordDir).filter((s) => s.id === "spotify");
  check("the export does NOT add a second Spotify row", spotifyRows.length === 1, `${spotifyRows.length} rows`);
  check(
    `the live Spotify row now covers the lifetime (${spotifyRows[0]?.coverage?.from} → ${spotifyRows[0]?.coverage?.to})`,
    spotifyRows[0]?.coverage?.from === "2019-04-02" && spotifyRows[0]?.coverage?.days === 3,
  );

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

  console.log("\na dropped file lands ONCE — content-hashed, so a re-drop is idempotent");
  {
    const dr = path.join(root, "record-drops");
    appendInboxItems([{ text: "same dropped content", source: "drop", kind: "text" }], { recordDir: dr });
    appendInboxItems([{ text: "same dropped content", source: "drop", kind: "text" }], { recordDir: dr });
    const drops = readInboxFromRecord(dr).filter((i) => i.source === "drop");
    check("re-dropping the same file adds nothing twice", drops.length === 1, `${drops.length} drop item(s)`);
    // A typed memo can legitimately recur — it must NOT be deduped by content.
    appendInboxItems([{ text: "recurring note", source: "memo", kind: "text" }], { recordDir: dr });
    appendInboxItems([{ text: "recurring note", source: "memo", kind: "text" }], { recordDir: dr });
    check("a typed memo can still recur (not content-deduped)", readInboxFromRecord(dr).filter((i) => i.source === "memo").length === 2);
    // A re-drop is a DUPLICATE, not a crash. appendInboxItem used to reach
    // `input.id!.trim()` on the skipped item and throw a TypeError, which
    // POST /api/inbox surfaced as a 500 — re-dropping a file failed with a server
    // error. It must hand back the row the record already holds, with its real
    // status, so nothing lands a `pending` copy over a `structured` one.
    updateInboxItems([{ id: readInboxFromRecord(dr)[0].id, status: "structured" }], { recordDir: dr });
    let again: ReturnType<typeof appendInboxItem> | null = null;
    let boom = "";
    try {
      again = appendInboxItem({ text: "same dropped content", source: "drop", kind: "text" }, { recordDir: dr });
    } catch (e) {
      boom = (e as Error).message;
    }
    check("re-dropping does not throw (it used to 500)", boom === "", boom);
    check(
      "…and hands back the row on disk, with the status it actually has",
      again?.status === "structured",
      String(again?.status),
    );
    check("…and still only one copy exists", readInboxFromRecord(dr).filter((i) => i.source === "drop").length === 1);
  }

  console.log("\na re-dropped file you had DISCARDED comes back to the pending queue");
  {
    // Dropping a file you threw away is you asking for it back. An inert
    // "already have that" is the file silently vanishing — it never reaches the
    // queue and the dropzone says nothing happened. Hit on the live instance:
    // dropped a PDF, nothing landed, no error.
    // inboxResolve is the production path and resolves the record from the DATA
    // DIR, so the store has to be shaped like a real one: <dataDir>/record.
    const rvRoot = path.join(root, "revive-store");
    const rv = path.join(rvRoot, "record");
    fs.mkdirSync(rv, { recursive: true });
    const priorDataDir = process.env.AGENTQS_DATA_DIR;
    process.env.AGENTQS_DATA_DIR = rvRoot;
    const dropped = appendInboxItem({ text: "the file I threw away", source: "drop", kind: "text" }, { recordDir: rv });
    updateInboxItems([{ id: dropped.id, status: "discarded" }], { recordDir: rv });
    const again = appendInboxItem({ text: "the file I threw away", source: "drop", kind: "text" }, { recordDir: rv });
    check("the re-drop resolves to the same content-keyed row", again.id === dropped.id, `${again.id} vs ${dropped.id}`);
    check("…which the record still holds as discarded", again.status === "discarded", again.status);
    const restored = inboxResolve(again.id, "restore");
    check("restore puts it back in the pending queue", restored.status === "pending", restored.status);
    check("…and it is countable as pending again", restored.pending === 1, String(restored.pending));
    check("…with exactly one copy in the record", readInboxFromRecord(rv).filter((i) => i.source === "drop").length === 1);
    // A STRUCTURED item must NOT come back this way: its cells are merged, and
    // structuring it again would write the data twice. That is log reject's job.
    updateInboxItems([{ id: again.id, status: "structured" }], { recordDir: rv });
    let refused = "";
    try {
      inboxResolve(again.id, "restore");
    } catch (e) {
      refused = (e as Error).message;
    }
    check("a structured capture refuses restore and names log reject", /log reject/.test(refused), refused);
    process.env.AGENTQS_DATA_DIR = priorDataDir;
  }

  console.log("\nan image capture lands, and no face ships the base64 back");
  {
    const im = path.join(root, "record-image");
    fs.mkdirSync(im, { recursive: true });
    // A ~3MB photo, as the dropzone posts it: the whole file base64 in `text`.
    const bytes = 3 * 1024 * 1024;
    const dataUrl = `data:image/jpeg;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
    check(
      "a 3MB photo is under the raw-capture ceiling",
      Buffer.byteLength(dataUrl) < MAX_INBOX_BYTES,
      `${(Buffer.byteLength(dataUrl) / 1024 / 1024).toFixed(1)}MB of ${MAX_INBOX_BYTES / 1024 / 1024}MB`,
    );
    check("…and carries no NUL, so the binary guard lets it through", !dataUrl.includes("\u0000"));
    const photo = appendInboxItem(
      { text: dataUrl, source: "drop", kind: "image", meta: { filename: "beach.jpg", bytes, mime: "image/jpeg" } },
      { recordDir: im },
    );
    check("the photo landed as an image capture", photo.kind === "image" && photo.text.startsWith("data:image/"));
    rebuild({ recordDir: im, dbPath: path.join(root, "image.db") });
    const idb = new Database(path.join(root, "image.db"), { readonly: true });
    const inboxRows = (idb.prepare("SELECT COUNT(*) AS n FROM raw_inbox").get() as { n: number }).n;
    const searchRows = (idb.prepare("SELECT COUNT(*) AS n FROM search WHERE kind = 'inbox'").get() as { n: number }).n;
    idb.close();
    check("…and is in the cache", inboxRows === 1, `${inboxRows} row(s)`);
    check("…but NOT in the search index (a base64 body is not text)", searchRows === 0, `${searchRows} search row(s)`);
    // The body is the file. A list that ships it hands the browser the whole photo
    // back to render two clamped lines of base64 — which is what the panel did.
    const summary = captureSummary(photo);
    check("a list shows what the capture IS, not its bytes", summary === "beach.jpg · image/jpeg · 3.0 MB", summary);
    check("…and a text capture is untouched by that", captureSummary({ kind: "text", text: "plain note", meta: null }) === "plain note");
  }

  console.log("\nthe dropzone routes on NAME OR MIME — a photo the browser can't name is still a photo");
  {
    // The bug this locks down: the image branch tested `f.type.startsWith("image/")`
    // while the PDF branch beside it matched name OR mime. So a HEIC from an iPhone,
    // a file dragged off a network share, and anything with an uppercase extension
    // missed the image branch, fell through to the text branch, were read with
    // f.text(), tripped the binary guard, and were skipped with NO reason given. The
    // photo never reached the server — 138 log entries, not one image capture.
    check("a normal photo routes to the image branch", captureRouteFor("beach.jpg", "image/jpeg") === "image");
    check("…with an EMPTY mime type it still does", captureRouteFor("beach.jpg", "") === "image", captureRouteFor("beach.jpg", ""));
    check("an iPhone .HEIC with no mime routes to the image branch", captureRouteFor("IMG_0421.HEIC", "") === "image", captureRouteFor("IMG_0421.HEIC", ""));
    check("…and .heif too", captureRouteFor("scan.heif", undefined) === "image");
    check("an UPPERCASE .JPG routes to the image branch", captureRouteFor("PHOTO.JPG", "") === "image", captureRouteFor("PHOTO.JPG", ""));
    check("a mime with no useful name still routes on mime", captureRouteFor("blob", "image/png") === "image");
    for (const e of ["png", "gif", "webp", "avif", "bmp", "tif", "tiff", "jpeg"]) {
      check(`.${e} routes to the image branch with no mime`, captureRouteFor(`x.${e}`, "") === "image", captureRouteFor(`x.${e}`, ""));
    }
    check("a PDF still routes to the PDF branch", captureRouteFor("statement.PDF", "") === "pdf", captureRouteFor("statement.PDF", ""));
    check("…and by mime alone", captureRouteFor("blob", "application/pdf") === "pdf");
    check("a CSV routes to the text branch", captureRouteFor("mood.csv", "text/csv") === "text");
    check("an unknown binary routes to the text branch, where it is refused BY NAME", captureRouteFor("archive.sqlite", "") === "text");
    // The predicates the routing is built from, on their own.
    check("looksImageName never lets an empty mime cast the deciding vote", looksImageName("a.heic", "") && !looksImageName("a.sqlite", ""));
    check("looksTextualName matches on extension too", looksTextualName("notes.md", "") && !looksTextualName("photo.jpg", ""));
    check("extensionOf is case-insensitive and dot-free", extensionOf("A.JPG") === "jpg" && extensionOf("noext") === "");
  }

  console.log("\nno silent skips — every refusal in the dropzone says why");
  {
    // A skip with no reason is indistinguishable from the app losing your file, and
    // that is exactly how it read: a bare "skipped" line for every photo the browser
    // gave an empty mime type. The `why` field is required by the type now, so tsc
    // enforces it — this catches the other half, someone widening the type back.
    const src = fs.readFileSync(path.join(process.cwd(), "src", "components", "dropzone.tsx"), "utf8");
    const pushes = src.match(/skipped\.push\([\s\S]*?\);/g) ?? [];
    check("the dropzone still has skip paths to check", pushes.length >= 5, `${pushes.length} found`);
    const bare = pushes.filter((push) => !/why:/.test(push));
    check("every skipped file carries a reason", bare.length === 0, bare.join(" | ").slice(0, 140));
    check(
      "the skip type REQUIRES a reason (tsc enforces the rest)",
      /skipped: \{ name: string; why: string \}\[\]/.test(src),
    );
    // An unsupported-but-real file type has to be diagnosable from the flash alone.
    check("the binary refusal names the extension it saw", /binary \$\{kind\} file/.test(src));
    check("…and `kind` is the real extension", /extensionOf\(f\.name\)/.test(src));
    check("the flash never prints a skip without its reason", !/couldn't read \$\{skipped/.test(src));
  }

  console.log("\na filename with no latin letters does not become a junk source name");
  {
    // Every non-ASCII character is stripped, so a Hebrew filename slugged to "2" —
    // a daily column literally called 2, with nothing to say what it held.
    check("a non-latin filename falls back to the default source", sourceName("2תוצאות הבדיקה.pdf", "notes") === "notes", sourceName("2תוצאות הבדיקה.pdf", "notes"));
    check("…so does a digits-only name", sourceName("2024.csv", "import") === "import", sourceName("2024.csv", "import"));
    check("a normal filename still slugs", sourceName("Mood Export.csv", "notes") === "mood_export", sourceName("Mood Export.csv", "notes"));
    check("a mixed name keeps its latin part", sourceName("weight תוצאות.csv", "notes") === "weight", sourceName("weight תוצאות.csv", "notes"));
  }

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
