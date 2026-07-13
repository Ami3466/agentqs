#!/usr/bin/env tsx
/**
 * Ships-when proof for Loop 11 · Integration batch (Tier 1).
 *
 *   1. Four+ live sources feed one daily record: GitHub (commits) + the three
 *      new record-contract plugins — RescueTime, Google Calendar, Spotify — each
 *      run through the real fetch → normalize → merge → rebuild pipeline (offline,
 *      against the sample fixtures). WHOOP rides its unofficial app-login pull.
 *   2. A cross-source question returns a grounded answer computed straight from
 *      the daily numbers (the keyless path), citing ≥2 sources.
 *
 * Drives the production code: importPlugin + mergeDailyCsv + rebuild, then
 * readGrounding + groundedCrossSourceAnswer. Deterministic, no network.
 * Run: npm run integration:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import { importPlugin } from "../src/lib/importers/plugin";
import { SOURCE_PLUGINS } from "../src/lib/importers/registry";
import { writeGithubRecord } from "../src/lib/importers/github";
import { importWhoop, whoopFixtureFetch } from "../src/lib/importers/whoop";
import { rebuild } from "../src/lib/record";
import { readDailySummary } from "../src/lib/daily";
import { readGrounding, groundedCrossSourceAnswer } from "../src/lib/grounding";
import { writeConfig, type AppConfig } from "../src/lib/config";
import { CRED, FIXTURES, fetchForFixture } from "./api-fixtures";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-integ-"));
  const recordDir = path.join(root, "record");
  const dbFile = path.join(root, "agentqs.db");
  const from = "2026-06-01";
  const to = "2026-06-30";
  // Hermetic store: every write must resolve to THIS temp root, never the real record.
  process.env.AGENTQS_DATA_DIR = root;
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date().toISOString(),
    backup: { passphrase: "fixture-pass" },
  } as AppConfig);

  console.log("\nSeeding one daily record from 4 live sources + WHOOP (unofficial)…\n");

  // GitHub — its own writer, a dense commits/day series correlated with focus.
  const ghDays = [
    { date: "2026-06-01", commits: 4 },
    { date: "2026-06-02", commits: 9 },
    { date: "2026-06-03", commits: 2 },
    { date: "2026-06-04", commits: 15 },
    { date: "2026-06-05", commits: 11 },
    { date: "2026-06-06", commits: 3 },
    { date: "2026-06-07", commits: 18 },
  ];
  writeGithubRecord(recordDir, ghDays);
  check("GitHub commits written to record/daily/github.csv", fs.existsSync(path.join(recordDir, "daily", "github.csv")));

  // Every single-credential plugin through the real import pipeline.
  for (const plugin of SOURCE_PLUGINS) {
    const body = JSON.parse(fs.readFileSync(path.resolve(FIXTURES[plugin.id]), "utf8"));
    const summary = await importPlugin(
      plugin,
      { from, to, credential: CRED[plugin.id], fetchImpl: fetchForFixture(plugin.id, body) },
      recordDir,
    );
    check(
      `${plugin.name} imported → daily/${plugin.id}.csv`,
      summary.rows > 0 && summary.cells > 0,
      `${summary.daysWithData} days, ${summary.cells} cells, metrics: ${summary.metrics.join("/")}`,
    );
  }

  // WHOOP through the UNOFFICIAL app login (email + password → token), offline.
  const ws = await importWhoop({
    creds: { email: "athlete@example.com", password: "secret" },
    from,
    to,
    recordDir,
    fetchImpl: whoopFixtureFetch({
      cycles: [
        { score: 71, hrv_rmssd_milli: 61, resting_heart_rate: 51, cycle: { days: "['2026-06-02T00:00:00.000Z','2026-06-03T00:00:00.000Z')", scaled_strain: 13.2 }, sleeps: [{ score: 90, quality_duration: 27_900_000 }] },
        { score: 44, hrv_rmssd_milli: 38, resting_heart_rate: 58, cycle: { days: "['2026-06-05T00:00:00.000Z','2026-06-06T00:00:00.000Z')", scaled_strain: 8.1 }, sleeps: [{ score: 68, quality_duration: 20_100_000 }] },
      ],
      heartRate: [
        { time: Date.parse("2026-06-05T08:00:00Z"), data: 61 },
        { time: Date.parse("2026-06-05T08:01:00Z"), data: 64 },
        { time: Date.parse("2026-06-05T08:02:00Z"), data: 132 },
      ],
    }),
  });
  check(
    "WHOOP (unofficial app login) imported → daily/whoop.csv",
    ws.cells > 0 && ws.metrics.includes("recovery"),
    `${ws.daysWithData} days, ${ws.cells} cells, ${ws.minutes} min HR, metrics: ${ws.metrics.join("/")}`,
  );

  // Rebuild the SQLite cache from the record (the source of truth).
  const r = rebuild({ recordDir, dbPath: dbFile });
  console.log(`\nRebuilt cache: ${r.daily} daily rows from the record.\n`);

  const summary = readDailySummary(dbFile, 5);
  const sourceIds = summary.sources.map((s) => s.source).sort();
  const liveExpected = ["gcal", "github", "rescuetime", "spotify"];
  const liveHit = liveExpected.filter((id) => sourceIds.includes(id));

  console.log("Ships-when 1 — four+ live sources feed the daily record");
  check(`4+ live sources present in daily table`, liveHit.length >= 4, `sources: ${sourceIds.join(", ")}`);
  for (const id of liveExpected) {
    const stat = summary.sources.find((s) => s.source === id);
    check(`${id} has rows`, Boolean(stat && stat.rows > 0), stat ? `${stat.rows} rows` : "missing");
  }
  check("WHOOP (unofficial) also landed rows", sourceIds.includes("whoop"));

  console.log("\nShips-when 2 — a cross-source question returns a grounded answer");
  const g = readGrounding(dbFile);
  check("grounding sees ≥4 sources", g.sources.length >= 4, g.sources.join(", "));

  const question = "How does my coding affect my productivity and focus?";
  const answer = groundedCrossSourceAnswer(g, question);
  check("a grounded answer was produced", Boolean(answer));
  if (answer) {
    console.log(`\n  Q: ${question}\n  A: ${answer.text}\n`);
    const twoSources = new Set(answer.sources).size >= 2;
    check("answer draws on ≥2 distinct sources", twoSources, answer.sources.join(" + "));
    check("answer quotes real numbers", /\d/.test(answer.text));
    check("answer names both metrics", answer.metrics.length === 2, answer.metrics.join(" vs "));
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(
    "\n✓ Integration batch ships: GitHub + RescueTime + Calendar + Spotify feed one record; a cross-source question is answered from the numbers.\n",
  );
}

void main();
