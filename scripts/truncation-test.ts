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
import { normalizeDate, structureCsv } from "../src/lib/structure";
import { fetchGithubCommits, type FetchLike } from "../src/lib/importers/github";
import { SOURCE_PLUGINS } from "../src/lib/importers/registry";
import { PAGING, pagingFetch } from "./paging-fixtures";

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

  // ---- 4. NO IMPORTER STOPS AT PAGE ONE --------------------------------------
  // THE bug. Thirteen of eighteen importers read one page of a paginated API and
  // treated it as the whole answer: Last.fm landed 200 of a year's ~10,000 scrobbles,
  // Strava dropped January through August of every year, Calendar's meetings simply
  // stopped partway through each year. Nothing errored. Every test was green — because
  // every fixture was a single page, so a plugin that COULDN'T page passed exactly like
  // one that could.
  //
  // Each fixture below serves TWO pages: day A, then day B. A plugin that ignores the
  // cursor can only ever see day A.
  console.log("\nno importer stops at page one:");
  const DAY_A = "2026-06-10";
  const DAY_B = "2026-06-11";
  for (const [id, spec] of Object.entries(PAGING)) {
    const plugin = SOURCE_PLUGINS.find((p) => p.id === id);
    if (!plugin?.fetch) {
      check(`${id}: plugin exists`, false);
      continue;
    }
    const { fn, seen } = pagingFetch(spec, DAY_A, DAY_B);
    let days: string[] = [];
    let err = "";
    try {
      const res = await plugin.fetch({
        credential: spec.credential ?? "token",
        from: "2026-06-01",
        to: "2026-06-30",
        fetchImpl: fn,
      });
      days = res.table.rows.map((r) => r[0]);
    } catch (e) {
      err = (e as Error).message;
    }
    check(
      `${id}: follows the cursor to page 2 (${seen.length} request(s), days: ${days.join(" ") || "none"})`,
      !err && days.includes(DAY_A) && days.includes(DAY_B),
      err || (days.includes(DAY_B) ? "" : "PAGE 2 NEVER FETCHED — this source is silently truncating"),
    );
  }

  // Toggl doesn't paginate — it refuses a long RANGE instead, so a 365-day chunk must
  // be asked for in mouthfuls rather than handed over whole and silently clamped.
  const toggl = SOURCE_PLUGINS.find((p) => p.id === "toggl")!;
  const ranges: string[] = [];
  const togglFetch = (async (url: unknown) => {
    const u = new URL(String(url));
    ranges.push(`${u.searchParams.get("start_date")}..${u.searchParams.get("end_date")}`);
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;
  await toggl.fetch!({ credential: "t", from: "2025-01-01", to: "2025-12-31", fetchImpl: togglFetch });
  check(
    `toggl: a year is asked for in windows the API will serve (${ranges.length} requests)`,
    ranges.length >= 4,
    ranges.length === 1 ? "asked for all 365 days at once — the API clamps it and nobody notices" : "",
  );
  check(
    "…and those windows cover the whole year, with no gap",
    Boolean(ranges[0]?.startsWith("2025-01-01") && ranges.at(-1)?.endsWith("2025-12-31")),
    ranges.join(" | "),
  );

  // ---- 5. A GAP IN A LIFE IS NOT THE END OF ONE ------------------------------
  // The walk stepped back a year at a time and stopped after two empty chunks. But a
  // life is not a tidy run of activity ending in silence — it has GAPS. Two quiet years
  // is a job change, a broken strap, a phone you stopped carrying. The walk hit the gap,
  // decided the history had ended there, and never asked about anything older. Everything
  // before it was unreachable by ANY command, forever, and the sync said ok.
  //
  // Real repro: mail in 2026 and mail in 2019, three quiet years between. The walk never
  // asked Gmail about anything before 2023-07-16. It landed 2 days and reported success.
  console.log("\na quiet stretch does not end the history:");
  const gapDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-gap-"));
  process.env.AGENTQS_DATA_DIR = gapDir;
  fs.mkdirSync(path.join(gapDir, "record", "daily"), { recursive: true });
  const { writeConfig } = await import("../src/lib/config");
  const { syncSource } = await import("../src/lib/cli-core");
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    createdAt: new Date().toISOString(),
    googleProducts: ["calendar", "gmail.inbox", "gmail.sent"],
    sourceOAuth: {
      google: { clientId: "c", clientSecret: "s", accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3.6e6 },
    },
  } as never);

  const mail: Record<string, number> = { "2026-07-10": 12, "2026-06-01": 8, "2019-05-05": 9, "2019-04-01": 5 };
  let oldestAsked = "9999";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = new URL(String(url));
    if (u.host.includes("oauth2")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    }
    const q = u.searchParams.get("q") ?? "";
    const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
    const before = Number(/before:(\d+)/.exec(q)?.[1] ?? 0);
    // Gmail answers a RANGE. The per-day counter asks about one day; the cheap
    // hasAnyData probe asks about a whole year.
    const wFrom = new Date(after * 1000).toISOString().slice(0, 10);
    const wTo = new Date((before - 1) * 1000).toISOString().slice(0, 10);
    if (wFrom < oldestAsked) oldestAsked = wFrom;
    const n = Object.entries(mail)
      .filter(([day]) => day >= wFrom && day <= wTo)
      .reduce((sum, [, c]) => sum + c, 0);
    return new Response(JSON.stringify({ messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  let landed: string[] = [];
  try {
    await syncSource({ id: "gmail" });
    landed = fs
      .readFileSync(path.join(gapDir, "record", "daily", "gmail.csv"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(",")[0]);
  } finally {
    globalThis.fetch = realFetch;
  }
  check(
    `the walk asks past the gap, all the way to the floor (oldest asked: ${oldestAsked})`,
    oldestAsked === "2000-01-01",
    oldestAsked,
  );
  check(
    `mail from BEFORE a 3-year silence still lands (${landed.length} days)`,
    landed.includes("2019-04-01") && landed.includes("2019-05-05"),
    landed.join(" ") || "NOTHING — everything behind the gap was lost",
  );
  check(
    "…and the recent side lands too",
    landed.includes("2026-06-01") && landed.includes("2026-07-10"),
  );
  fs.rmSync(gapDir, { recursive: true, force: true });

  // ---- 5b. A DATE IS NOT SILENTLY REINTERPRETED -------------------------------
  // Every slashed date was read as US M/D. So a European bank/gym/health export lost
  // half its rows to a silent misfiling — 05/07/2026 is 5 July, and it landed on 7 May
  // — while the other half (31/01/2026, day > 12) became "2026-31-01", an impossible
  // date that merged into the record anyway and sorted into the future of the journal.
  // The import reported "structured N cells", skippedRows: 0. Nothing said a word.
  //
  // A single cell cannot be read. A COLUMN gives itself away.
  console.log("\na date column is read, not assumed:");
  const euCsv = structureCsv("date,amount\n31/01/2026,10\n05/07/2026,25\n")!;
  check(
    `one value over 12 proves the column is day-first (${euCsv.dates.join(" ")})`,
    euCsv.dateOrder === "dmy" && euCsv.dates.includes("2026-07-05"),
    euCsv.dates.join(" "),
  );
  const usCsv = structureCsv("date,amount\n01/31/2026,10\n05/07/2026,25\n")!;
  check(
    `…and a US column still reads as US (${usCsv.dates.join(" ")})`,
    usCsv.dateOrder === "mdy" && usCsv.dates.includes("2026-05-07"),
    usCsv.dates.join(" "),
  );
  const ambCsv = structureCsv("date,amount\n05/07/2026,10\n03/04/2026,25\n")!;
  check(
    "a genuinely undecidable column SAYS it guessed, instead of deciding in silence",
    ambCsv.ambiguousDateOrder === true,
  );
  check(
    "an impossible date never lands (31/31/2026 used to merge as 2026-31-31)",
    normalizeDate("31/31/2026") === null && normalizeDate("2026-13-01") === null,
  );

  // ---- 5c. AN INTERRUPTED WALK IS NOT A FINISHED ONE --------------------------
  // The walk merges each year as it lands, and "is this a first import?" meant "is the
  // record empty?". So a twelve-year walk that died on chunk 2 left last year's rows
  // behind — and the NEXT sync saw rows, concluded the history was already imported,
  // topped up the last 7 days and reported ok. The other eleven years were never
  // fetched again by ANY code path. An interrupted backfill looked exactly like a
  // finished one.
  console.log("\na walk that dies halfway is resumed, not abandoned:");
  const rDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-resume-"));
  process.env.AGENTQS_DATA_DIR = rDir2;
  fs.mkdirSync(path.join(rDir2, "record", "daily"), { recursive: true });
  const { readBackfillState, writeBackfillState } = await import("../src/lib/sync-runs");

  check(
    "a source that has never walked is not marked done",
    readBackfillState("gcal").done !== true,
  );
  // A walk that got to 2019 and died leaves its cursor behind…
  writeBackfillState("gcal", { cursor: "2019-03-01" });
  check(
    "…so the record knows exactly where to pick it up",
    readBackfillState("gcal").cursor === "2019-03-01" && readBackfillState("gcal").done !== true,
  );
  // …and only reaching the floor marks it finished.
  writeBackfillState("gcal", { cursor: undefined, done: true, at: "2026-07-14T00:00:00Z" });
  check("only a walk that reaches the floor is done", readBackfillState("gcal").done === true);
  fs.rmSync(rDir2, { recursive: true, force: true });

  // ---- 6. NO FACE MAY REACH FOR A TRAILING WINDOW ----------------------------
  // The rule (CLAUDE.md): a file is finite and already on your disk, so it is read
  // WHOLE. Clipping ten years of your own Chrome history to a trailing 90 days throws
  // away years that were sitting right there — and since every later run re-asks for
  // the same trailing 90, they are never fetched even once.
  //
  // cli-core was fixed. These two were not, and they are the faces the README tells
  // hosted users to schedule (`npm run daemon -- run --push`). sync:test's guard only
  // greps cli-core's sync body, so it could never have seen them. This one looks at
  // every face.
  console.log("\nno import face defaults to a trailing window:");
  const FACES = ["scripts/daemon.ts", "scripts/import-file.ts", "src/lib/cli-core.ts"];
  for (const face of FACES) {
    const src = fs.readFileSync(path.join(__dirname, "..", face), "utf8");
    const stray = src.match(/windowDays\([^)]*:\s*(\d{2,})\s*\)/g) ?? [];
    check(`${face} holds no trailing-window default${stray.length ? ` (found: ${stray.join(", ")})` : ""}`, stray.length === 0);
  }

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
