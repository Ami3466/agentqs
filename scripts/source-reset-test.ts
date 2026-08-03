/**
 * Ships-when proof for `source reset` — wipe what a source LANDED, keep its CONNECTION.
 *
 * The bug this repairs is the residue of every truncation/bucketing bug the record has
 * survived: GitHub's densify() zero-filling nine years, an importer bucketing a day by
 * UTC and filing it on the wrong one, a count decayed by a recency buffer. Fixing the
 * IMPORTER does not fix the RECORD, because a sync MERGES: it can raise a value, but it
 * can never delete a row the corrected importer no longer writes at all. The invented
 * rows are precisely the ones that survive a re-walk.
 *
 * disconnectSource starts the file empty, but it also forgets the credential — so
 * cleaning a poisoned OAuth source meant re-running the whole authorize dance just to
 * drop bad rows. resetSource is the same wipe with the key left in.
 *
 * Drives production code (mergeDailyCsv, resetSource, disconnectSource, buildSources)
 * against a temp AGENTQS_DATA_DIR. No network.
 * Run: npm run reset:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-reset-"));
// Set the data dir BEFORE any lib call — paths.dataDir() reads the env lazily.
process.env.AGENTQS_DATA_DIR = root;

import Database from "better-sqlite3";
import { readConfig, writeConfig } from "../src/lib/config";
import { appendEvents, mergeDailyCsv, rebuild, readDailyFromRecord } from "../src/lib/record";
import { dbPath } from "../src/lib/paths";
import { coverageBySource } from "../src/lib/daily";
import { disconnectSource, resetSource } from "../src/lib/cli-core";
import { buildSources } from "../src/lib/source-registry";
import { recordDir } from "../src/lib/paths";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${detail && !cond ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

const SRC = "fitwatch";
const rDir = () => recordDir();

/** What the cache holds, across every table a source removal has to clean. Two
 *  caches that agree on this agree on everything a reader can see. */
function cacheCounts(): { daily: number; events: number; dailySearch: number; eventSearch: number } {
  const db = new Database(dbPath(), { readonly: true });
  try {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      daily: n("SELECT COUNT(*) AS n FROM daily"),
      events: n("SELECT COUNT(*) AS n FROM events"),
      dailySearch: n("SELECT COUNT(*) AS n FROM search WHERE kind = 'daily'"),
      eventSearch: n("SELECT COUNT(*) AS n FROM search WHERE kind = 'event'"),
    };
  } finally {
    db.close();
  }
}
const dailyFile = () => path.join(rDir(), "daily", `${SRC}.csv`);
/** Steps the RECORD (the source of truth, plain text) holds for a day — undefined = no row. */
const stepsOn = (date: string): number | null | undefined =>
  readDailyFromRecord(rDir()).find((r) => r.date === date && r.source === SRC && r.metric === "steps")
    ?.valueNum;

function main() {
  writeConfig({
    user: { email: "t@example.com", passwordHash: "x" },
    // The connection we must NOT lose: a stored credential, an OAuth grant, a schedule.
    sourceCreds: { [SRC]: "secret-key-abc" },
    sourceOAuth: { [SRC]: { accessToken: "at-1", refreshToken: "rt-1" } },
    sourceIntervals: { [SRC]: "daily" },
    sourceSyncedAt: { [SRC]: "2026-07-01T00:00:00.000Z" },
  } as never);

  console.log("\nScenario 1 — a poisoned record: invented zeros + a row on the wrong day");
  // What a buggy importer left behind: zero-filled days from before the account existed,
  // and a real day bucketed by UTC onto the day after the user actually lived it.
  mergeDailyCsv(rDir(), SRC, {
    header: ["date", "steps"],
    rows: [
      ["2019-03-01", "0"], // densify() zero-fill — the account did not exist yet
      ["2019-03-02", "0"], // ditto
      ["2026-06-10", "9000"], // the real day…
      ["2026-06-11", "9000"], // …and its UTC twin, filed a day late
    ],
  });
  rebuild({ recordDir: rDir() });
  check("the poison is in the record", stepsOn("2019-03-01") === 0 && stepsOn("2026-06-11") === 9000);

  console.log("\nScenario 2 — fixing the IMPORTER does not fix the RECORD (a sync only merges)");
  // The corrected importer: no invented zeros, the day on the day it was lived. This is
  // exactly what a re-walk after the bug fix lands.
  const corrected = { header: ["date", "steps"], rows: [["2026-06-10", "9000"]] };
  mergeDailyCsv(rDir(), SRC, corrected);
  rebuild({ recordDir: rDir() });
  check(
    "the invented zeros SURVIVE the re-walk — a merge cannot delete what it never writes",
    stepsOn("2019-03-01") === 0,
    "the zero is gone, so this test no longer proves why reset exists",
  );
  check("the wrong-day row survives it too", stepsOn("2026-06-11") === 9000);

  console.log("\nScenario 3 — reset wipes the data and KEEPS the connection");
  const result = resetSource(SRC);
  check("the daily file is gone", !fs.existsSync(dailyFile()));
  check("the cache holds no rows for it either", !coverageBySource().has(SRC));
  check("it reports what it cleared", result.reset === true && result.sources.includes(SRC));

  const cfg = readConfig()!;
  // The whole point: cleaning a poisoned source must not cost you the OAuth dance.
  check("the credential is KEPT", cfg.sourceCreds?.[SRC] === "secret-key-abc");
  check("the OAuth grant is KEPT", cfg.sourceOAuth?.[SRC]?.refreshToken === "rt-1");
  check("the schedule is KEPT", cfg.sourceIntervals?.[SRC] === "daily");
  // The one config key that describes the DATA, not the connection — after a reset it
  // would be claiming a sync with nothing left to show for it.
  check("the last-sync stamp is cleared", !cfg.sourceSyncedAt?.[SRC]);

  console.log("\nScenario 4 — the re-walk now lands clean, because it starts from empty");
  mergeDailyCsv(rDir(), SRC, corrected);
  rebuild({ recordDir: rDir() });
  check("the real day is back", stepsOn("2026-06-10") === 9000);
  check("the invented zeros are GONE", stepsOn("2019-03-01") === undefined && stepsOn("2019-03-02") === undefined);
  check("the wrong-day row is GONE", stepsOn("2026-06-11") === undefined);
  const row = buildSources(readConfig(), rDir()).find((s) => s.id === SRC);
  check("the source still holds its data and its key", Boolean(row?.hasData));

  console.log("\nScenario 5 — reset is NOT disconnect: disconnect still takes the key");
  // Removing a source PATCHES the cache — it used to rebuild it, which re-reads the
  // whole record and re-indexes every event (minutes of frozen server on a real
  // record, for a delete). The patch only earns that if it leaves the same cache a
  // rebuild would, including the event layer and the FTS index, so that is asserted
  // rather than assumed. The source lands an event first, so the check has one to lose.
  appendEvents(
    [{ id: `${SRC}-evt-1`, date: "2026-06-10", source: SRC, text: "a step-count sync", ts: "2026-06-10T08:00:00.000Z" }],
    { recordDir: rDir() },
  );
  rebuild({ recordDir: rDir() });
  check("the source has an event to lose", cacheCounts().events === 1);
  disconnectSource(SRC);
  const patched = cacheCounts();
  rebuild({ recordDir: rDir() });
  check(
    "the patched cache after disconnect is identical to a full rebuild's",
    JSON.stringify(patched) === JSON.stringify(cacheCounts()),
    `${JSON.stringify(patched)} vs ${JSON.stringify(cacheCounts())}`,
  );
  check("the source's events left with it", patched.events === 0 && patched.eventSearch === 0);
  const after = readConfig()!;
  check("disconnect drops the credential", !after.sourceCreds?.[SRC] && !after.sourceOAuth?.[SRC]);
  check("disconnect drops the data too", !fs.existsSync(dailyFile()));

  console.log("\nScenario 6 — an unknown source is refused, not silently reset");
  let threw = false;
  try {
    resetSource("not-a-source");
  } catch {
    threw = true;
  }
  check("unknown source throws", threw);
}

try {
  main();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n✗ ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log(
  "\n✓ source reset ships: a poisoned record is cleaned by starting the file empty — a re-sync only merges, so it can raise a value but never delete an invented row — and the credential, grant and schedule survive it.\n",
);
