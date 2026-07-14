#!/usr/bin/env tsx
/**
 * API-first proof (Task 8) — every source that ships an API is pulled through it,
 * never a manual export. Drives each single-credential API plugin end to end:
 *
 *   fixture body → plugin.fetch (real request shape, offline) → normalize →
 *   mergeDailyCsv → record/daily/<id>.csv → assert the primary-metric column has
 *   real numbers for the window.
 *
 * Covers the sources added in this task (Oura, Fitbit, Strava, Last.fm, Toggl,
 * Todoist, Trakt, Notion) plus the earlier three (RescueTime, Calendar, Spotify),
 * so every source in the registry is exercised through the live import path.
 * Deterministic, no network. Run: npm run api:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import { importPlugin } from "../src/lib/importers/plugin";
import { SOURCE_PLUGINS } from "../src/lib/importers/registry";
import { parseCsv } from "../src/lib/record";
import { writeConfig, type AppConfig } from "../src/lib/config";
import { CRED, FIXTURES, fetchForFixture } from "./api-fixtures";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-api-"));
  const recordDir = path.join(root, "record");
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
    // Gmail only fetches what is TICKED (an unticked half must never land a column),
    // so a fixture run that leaves it at the default would import nothing at all.
    googleProducts: ["calendar", "gmail.inbox", "gmail.sent"],
  } as AppConfig);

  console.log(`\nAPI-first — driving ${SOURCE_PLUGINS.length} API sources through the real import path\n`);

  for (const plugin of SOURCE_PLUGINS) {
    const fx = FIXTURES[plugin.id];
    check(`${plugin.name}: has a fixture`, Boolean(fx));
    if (!fx) continue;
    const body = JSON.parse(fs.readFileSync(path.resolve(fx), "utf8"));
    const summary = await importPlugin(
      plugin,
      { from, to, credential: CRED[plugin.id], fetchImpl: fetchForFixture(plugin.id, body) },
      recordDir,
    );

    const file = path.join(recordDir, "daily", `${plugin.id}.csv`);
    const exists = fs.existsSync(file);
    check(`${plugin.name}: wrote record/daily/${plugin.id}.csv`, exists);
    if (!exists) continue;

    const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
    // Every SOURCE lands a headline metric (only a backup target has none, and
    // backup targets are not sources — they never reach this loop).
    const metric = plugin.primaryMetric ?? "";
    check(`${plugin.name}: header has date + ${metric}`,
      Boolean(metric) && header[0] === "date" && header.includes(metric),
      header.join(","));

    const mi = header.indexOf(metric);
    const withMetric = rows.filter((r) => (r[mi] ?? "").trim() !== "" && Number.isFinite(Number(r[mi])));
    check(`${plugin.name}: ${metric} has real numbers`,
      summary.rows > 0 && withMetric.length > 0,
      `${withMetric.length} days, latest ${metric}=${withMetric.at(-1)?.[mi]}`);

    // The bug that hid "today": the summary feed only carries COMPLETED days, so
    // hours must come from the data API — assert the interval-only day (no pulse
    // yet) still landed its hours.
    if (plugin.id === "rescuetime") {
      const hi = header.indexOf("total_hours");
      const today = rows.find((r) => r[header.indexOf("date")] === "2026-06-08");
      check("RescueTime: an in-progress day (no pulse yet) lands its hours",
        Boolean(today) && Number(today?.[hi]) === 6,
        `total_hours=${today?.[hi] ?? "missing"}`);
      check("RescueTime: the in-progress day has no fake pulse",
        (today?.[mi] ?? "") === "");
    }

    // A rich source (Granola) also lands prose the search index can reach and one
    // event per item on the journal timeline. Both go through importPlugin, so the
    // same fixture run proves them.
    for (const extra of summary.extraSources) {
      const extraFile = path.join(recordDir, "daily", `${extra}.csv`);
      const ok = fs.existsSync(extraFile);
      check(`${plugin.name}: wrote record/daily/${extra}.csv`, ok);
      if (!ok) continue;
      const t = parseCsv(fs.readFileSync(extraFile, "utf8"));
      const ti = t.header.indexOf("text");
      const prose = t.rows.filter((r) => (r[ti] ?? "").trim().length >= 20);
      check(`${plugin.name}: ${extra} carries searchable prose`, ti >= 0 && prose.length > 0,
        `${prose.length} day(s), ${prose[0]?.[ti]?.length ?? 0} chars`);
    }

    if (summary.eventsAdded > 0) {
      const lines = fs.readFileSync(path.join(recordDir, "events.jsonl"), "utf8").trim().split("\n");
      const mine = lines.map((l) => JSON.parse(l) as { source: string }).filter((e) => e.source === plugin.id);
      check(`${plugin.name}: ${summary.eventsAdded} event(s) on the journal timeline`,
        mine.length === summary.eventsAdded, `${mine.length} in events.jsonl`);
    }
  }

  fs.rmSync(root, { recursive: true, force: true });

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(`\n✓ API-first: all ${SOURCE_PLUGINS.length} API sources import through their API into the daily record.\n`);
}

void main();
