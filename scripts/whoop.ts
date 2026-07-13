#!/usr/bin/env tsx
/**
 * Ships-when proof for WHOOP via the UNOFFICIAL app login (Task 7).
 *
 * Drives the production code (no mocks of the thing under test, no network):
 *   1. whoopLogin / whoopRefresh exchange creds → a bearer session (the app's
 *      password + refresh_token grants).
 *   2. ensureSession re-uses a still-valid cached token WITHOUT a network call,
 *      refreshes an expired one, and re-logs-in when the refresh is dead.
 *   3. importWhoop pulls cycles + PER-MINUTE heart rate through the real
 *      normalize → merge → write pipeline: daily/whoop.csv gets recovery, HRV
 *      (seconds→ms), resting HR, strain, sleep hours + per-minute-derived
 *      hr_avg/hr_max, and record/whoop/hr/<date>.csv holds the minute stream.
 *   4. The pull is idempotent (re-run → byte-identical daily file) and the record
 *      rebuilds into the daily table.
 *
 * Run: npm run whoop:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureSession,
  fetchHeartRate,
  importWhoop,
  whoopFixtureFetch,
  whoopHrDir,
  whoopLogin,
  type WhoopCreds,
} from "../src/lib/importers/whoop";
import { parseCsv, rebuild } from "../src/lib/record";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// The cycles-details BFF shape: recovery/HRV(ms)/resting-HR at the record level,
// strain on `cycle`, `days` a stringified range, sleep under `sleeps`.
const CYCLES = [
  { score: 68, hrv_rmssd_milli: 55, resting_heart_rate: 52, cycle: { days: "['2026-06-01T00:00:00.000Z','2026-06-02T00:00:00.000Z')", scaled_strain: 12.4 }, sleeps: [{ score: 88, quality_duration: 27_000_000 }] },
  { score: 41, hrv_rmssd_milli: 33, resting_heart_rate: 60, cycle: { days: "['2026-06-02T00:00:00.000Z','2026-06-03T00:00:00.000Z')", scaled_strain: 7.9 }, sleeps: [{ score: 63, quality_duration: 19_800_000 }] },
];

// A per-minute window on 2026-06-02: three good beats + one gap (0 → dropped).
const HR = [
  { time: Date.parse("2026-06-02T07:00:00Z"), data: 58 },
  { time: Date.parse("2026-06-02T07:01:00Z"), data: 62 },
  { time: Date.parse("2026-06-02T07:02:00Z"), data: 140 },
  { time: Date.parse("2026-06-02T07:03:00Z"), data: 0 }, // gap marker
];

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-whoop-"));
  const recordDir = path.join(root, "record");
  const dbFile = path.join(root, "agentqs.db");

  console.log("\nWHOOP unofficial app login — auth, per-minute pull, merge.\n");

  // 1. Sign-in (username + password) returns a usable session at the live host.
  const login = await whoopLogin("athlete@example.com", "secret", whoopFixtureFetch({ userId: 42 }));
  check("whoopLogin → bearer session", Boolean(login.accessToken), `userId ${login.userId}`);
  check("login resolves the user id", login.userId === 42, `userId ${login.userId}`);
  check("login sets a future token expiry", new Date(login.expiresAt).getTime() > Date.now());

  // 2. ensureSession re-uses a valid cached token with NO network call.
  let calls = 0;
  const counting = whoopFixtureFetch({ userId: 42, onCall: () => calls++ });
  const cached: WhoopCreds = {
    email: "a@b.c",
    password: "p",
    accessToken: "still-good",
    refreshToken: "r",
    userId: 42,
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const reused = await ensureSession(cached, counting);
  check("ensureSession re-uses a valid token (no network)", calls === 0 && reused.session.accessToken === "still-good");

  // Expired cache → it refreshes (one network call, new token).
  const expired: WhoopCreds = { ...cached, tokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
  const rotated = await ensureSession(expired, counting);
  check("ensureSession refreshes an expired token", calls === 1 && rotated.session.accessToken !== "still-good");

  // 3. Full import through the unofficial pull.
  const fetchImpl = whoopFixtureFetch({ userId: 42, cycles: CYCLES, heartRate: HR });
  const s = await importWhoop({
    creds: { email: "athlete@example.com", password: "secret" },
    from: "2026-06-01",
    to: "2026-06-02",
    recordDir,
    fetchImpl,
  });
  check("importWhoop wrote daily rows", s.cells > 0, `${s.daysWithData} days, ${s.cells} cells`);
  check("importWhoop captured per-minute HR (gap dropped)", s.minutes === 3, `${s.minutes} minutes across ${s.hrDays} day(s)`);
  check("importWhoop rotated tokens onto creds", Boolean(s.creds.accessToken && s.creds.userId === 42));

  // daily/whoop.csv content — all five metric families + HR rollup present.
  const daily = fs.readFileSync(path.join(recordDir, "daily", "whoop.csv"), "utf8");
  const { header, rows } = parseCsv(daily);
  for (const col of ["recovery", "hrv", "resting_hr", "strain", "sleep_hours", "sleep_perf", "hr_avg", "hr_max"]) {
    check(`daily/whoop.csv has "${col}"`, header.includes(col));
  }
  const day2 = rows.find((r) => r[0] === "2026-06-02")!;
  const cell = (col: string) => day2[header.indexOf(col)];
  check("recovery from record.score", cell("recovery") === "41", `recovery=${cell("recovery")}`);
  check("HRV in ms (hrv_rmssd_milli)", cell("hrv") === "33", `hrv=${cell("hrv")}`);
  check("strain from cycle.scaled_strain", cell("strain") === "7.9", `strain=${cell("strain")}`);
  check("sleep duration ms→hours", cell("sleep_hours") === "5.5", `sleep_hours=${cell("sleep_hours")}`); // 19_800_000ms
  check("hr_avg from per-minute stream", cell("hr_avg") === "86.67", `hr_avg=${cell("hr_avg")}`); // (58+62+140)/3
  check("hr_max from per-minute stream", cell("hr_max") === "140", `hr_max=${cell("hr_max")}`);

  // Per-minute file exists with time,bpm header and one row per good sample.
  const hrFile = path.join(whoopHrDir(recordDir), "2026-06-02.csv");
  const hrLines = fs.readFileSync(hrFile, "utf8").trim().split("\n");
  check("record/whoop/hr/2026-06-02.csv per-minute stream", hrLines[0] === "time,bpm" && hrLines.length === 4);

  // 3b. The HR endpoint rejects any window over 192h (8 days) with a 400. A wide
  //     backfill must chunk into ≤7-day calls, never send one 14-day request.
  let hrCalls = 0;
  const wideFetch = whoopFixtureFetch({
    userId: 42,
    heartRate: HR,
    onCall: (u) => { if (u.includes("/metrics-service/")) hrCalls++; },
  });
  const wide = await fetchHeartRate(42, "tok", "2026-06-01", "2026-06-20", wideFetch);
  check("HR pull chunks a 20-day window (≤7-day calls, no 400)", hrCalls >= 3, `${hrCalls} HR calls`);
  check("chunked HR still returns samples", wide.length > 0, `${wide.length} samples`);

  // 4. Idempotent — a second identical pull yields a byte-identical daily file.
  const before = fs.readFileSync(path.join(recordDir, "daily", "whoop.csv"));
  await importWhoop({
    creds: { email: "athlete@example.com", password: "secret" },
    from: "2026-06-01",
    to: "2026-06-02",
    recordDir,
    fetchImpl: whoopFixtureFetch({ userId: 42, cycles: CYCLES, heartRate: HR }),
  });
  const after = fs.readFileSync(path.join(recordDir, "daily", "whoop.csv"));
  check("re-running the pull is byte-identical", before.equals(after));

  // Record rebuilds into the daily table.
  const r = rebuild({ recordDir, dbPath: dbFile });
  check("record rebuilds with WHOOP rows", r.daily > 0, `${r.daily} daily rows`);

  // 5. TWO accounts — a second athlete ("whoop-2") lands in its OWN daily file and
  //    per-minute dir, never overwriting the base account's data.
  await importWhoop({
    creds: { email: "athlete2@example.com", password: "secret2" },
    from: "2026-06-01",
    to: "2026-06-02",
    recordDir,
    instanceId: "whoop-2",
    fetchImpl: whoopFixtureFetch({ userId: 99, cycles: CYCLES, heartRate: HR }),
  });
  check("2nd account writes daily/whoop-2.csv", fs.existsSync(path.join(recordDir, "daily", "whoop-2.csv")));
  check("2nd account's per-minute dir is separate", fs.existsSync(whoopHrDir(recordDir, "whoop-2")));
  check("base account's daily file is untouched", fs.readFileSync(path.join(recordDir, "daily", "whoop.csv")).equals(after));
  check("the two HR dirs are distinct", whoopHrDir(recordDir, "whoop") !== whoopHrDir(recordDir, "whoop-2"),
    `${whoopHrDir(recordDir, "whoop")} vs ${whoopHrDir(recordDir, "whoop-2")}`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "✓ all WHOOP checks passed"}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
