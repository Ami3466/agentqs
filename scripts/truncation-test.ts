#!/usr/bin/env tsx
/**
 * Ships-when proof for: NOTHING IS SILENTLY TRUNCATED.
 *
 * The bug the user kept finding, over and over, in every corner of the pipeline:
 * data arrives PARTIALLY, gets written as if it were whole, and the sync reports ok.
 * The record then quietly asserts something false about someone's life — that they
 * wrote no code for nine years, that they listened to six tracks on a day they played
 * eighty-seven, that a 4,812-row expense export was 300 rows.
 *
 * Every check here is a bug that SHIPPED. They are grouped in one file on purpose:
 * this is a CLASS, not a list of incidents, and a new source that truncates should
 * fail here rather than be discovered by opening the app.
 *
 * Drives production code against temp dirs — no network. Run: npm run truncation:test
 */
import fs from "fs";
import os from "os";
import path from "path";

import { mergeDailyCsv } from "../src/lib/record";
import { structureCsv } from "../src/lib/structure";
import { fetchGithubCommits, type FetchLike } from "../src/lib/importers/github";
import { SOURCE_PLUGINS } from "../src/lib/importers/registry";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-trunc-"));
  fs.mkdirSync(path.join(dir, "daily"), { recursive: true });
  return dir;
}

async function main() {
  // ---- 1. A PARTIAL VIEW NEVER LOWERS A FULLER ONE ---------------------------
  // Spotify serves the last ~50 plays and no date range, so it recomputes a day from
  // whatever slice of it is still in that buffer. Replacing on every sync meant each
  // day's count DECAYED as the buffer slid past it — and an imported lifetime export
  // was eaten by the very next sync that touched one of its days.
  console.log("\na source that sees part of a day never overwrites a fuller count:");
  const rDir = tmp();
  mergeDailyCsv(rDir, "spotify", {
    header: ["date", "tracks", "minutes"],
    rows: [["2026-07-12", "87", "310"]], // the export: the real day
  });
  mergeDailyCsv(
    rDir,
    "spotify",
    { header: ["date", "tracks", "minutes"], rows: [["2026-07-12", "6", "21"]] }, // a sync that can only still see 6 of them
    { policy: "max" },
  );
  const spotify = fs.readFileSync(path.join(rDir, "daily", "spotify.csv"), "utf8");
  check("the export survives the next sync", spotify.includes("2026-07-12,87,310"), spotify.trim().split("\n")[1]);

  mergeDailyCsv(
    rDir,
    "spotify",
    { header: ["date", "tracks", "minutes"], rows: [["2026-07-12", "91", "330"]] },
    { policy: "max" },
  );
  const grown = fs.readFileSync(path.join(rDir, "daily", "spotify.csv"), "utf8");
  check("…but a genuinely fuller count still lands (the day is not frozen)", grown.includes("2026-07-12,91,330"));

  // A gauge must NEVER take a max — the default policy replaces, as it always did.
  mergeDailyCsv(rDir, "withings", { header: ["date", "weight_kg"], rows: [["2026-07-12", "80"]] });
  mergeDailyCsv(rDir, "withings", { header: ["date", "weight_kg"], rows: [["2026-07-12", "78"]] });
  const weight = fs.readFileSync(path.join(rDir, "daily", "withings.csv"), "utf8");
  check("a gauge still replaces — losing weight is not data loss", weight.includes("2026-07-12,78"));

  // Every source that recomputes a day from a recency buffer must say so, or it will
  // silently eat its own history the first time a sync re-touches a day.
  for (const id of ["spotify", "deezer", "swarm", "mastodon", "notion"]) {
    const p = SOURCE_PLUGINS.find((x) => x.id === id);
    check(`${id} declares mergePolicy "max" (it can only ever see a slice of a day)`, p?.mergePolicy === "max");
  }
  fs.rmSync(rDir, { recursive: true, force: true });

  // ---- 2. AN API CEILING IS SPLIT, NEVER TRUNCATED ---------------------------
  // GitHub's Search API serves at most 1,000 results per query. The importer asked for
  // twelve years, took the oldest 1,000, and then ZERO-FILLED every remaining day of
  // the window — writing `date,0` straight over nine years of real commits, and
  // reporting ok. The `capped` flag that would have caught it was never read.
  console.log("\nan API that caps its answer gets asked again, not believed:");
  const commits: string[] = [];
  const start = Date.UTC(2014, 0, 1);
  for (let i = 0; i < 8000; i++) {
    commits.push(new Date(start + Math.floor(i / 2) * 86_400_000).toISOString().slice(0, 10));
  }
  const realDays = new Set(commits);
  const fake: FetchLike = (async (url: unknown) => {
    const u = new URL(String(url));
    const q = u.searchParams.get("q") ?? "";
    const [from, to] = (/author-date:(\S+)\.\.(\S+)/.exec(q) ?? []).slice(1);
    const page = Number(u.searchParams.get("page") ?? 1);
    const inWin = commits.filter((d) => d >= from && d <= to).sort();
    const servable = inWin.slice(0, 1000); // THE CEILING: it reports the true total, serves 1000
    const items = servable
      .slice((page - 1) * 100, page * 100)
      .map((d) => ({ commit: { author: { date: `${d}T12:00:00Z` } } }));
    return new Response(JSON.stringify({ total_count: inWin.length, items }), { status: 200 });
  }) as unknown as FetchLike;

  const gh = await fetchGithubCommits({ token: "t", login: "me", from: "2014-01-01", to: "2026-07-14", fetchImpl: fake });
  check(`every commit is counted, not the first 1,000 (${gh.total})`, gh.total === 8000, String(gh.total));
  const zeroed = gh.days.filter((d) => d.commits === 0 && realDays.has(d.date));
  check(`no real commit day is written as 0 (${zeroed.length} zeroed)`, zeroed.length === 0, zeroed[0]?.date ?? "");
  check("and it does not claim it was capped", gh.capped === false);

  // ---- 3. PER-EVENT DATA IS NOT FLATTENED INTO A DAY -------------------------
  // The daily table holds ONE row per date and mergeDailyCsv is keyed by date, so a
  // file with three expenses on Tuesday kept only the LAST one — while the receipt
  // reported all of them as structured. The loudest silent loss in the whole path.
  console.log("\na per-event file is rolled up, never flattened on the way in:");
  const perEvent = structureCsv("date,amount\n2026-07-01,10\n2026-07-01,25\n2026-07-01,7\n2026-07-02,5\n")!;
  check("the parse COUNTS the rows that share a date", perEvent.duplicateDates === 2, String(perEvent.duplicateDates));

  const daily = structureCsv("date,steps\n2026-07-01,900\n2026-07-02,1200\n")!;
  check("a genuine daily file reports none", daily.duplicateDates === 0);

  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ Nothing is silently truncated: a partial view never overwrites a fuller one, an API ceiling is split rather than believed, and per-event data is never flattened into a day.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
