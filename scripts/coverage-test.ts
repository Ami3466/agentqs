#!/usr/bin/env tsx
/**
 * Coverage test — drives the real buildCoverage() over a rebuilt cache in a temp
 * data dir. No network. Exits 1 on any mismatch. Mirrors the record.rebuild() path
 * so it proves the same brain the Pipeline heatmap, /api/coverage, CLI and MCP all call.
 */
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-coverage-"));
process.env.AGENTQS_DATA_DIR = tmp;

import { rebuild } from "../src/lib/record";
import { dbPath } from "../src/lib/paths";
import { writeConfig } from "../src/lib/config";
import { buildCoverage } from "../src/lib/coverage";
import { readGraphSeries } from "../src/lib/graphs";

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`);
  }
}

// Empty record → empty report (no throw, no db).
const empty = buildCoverage(path.join(tmp, "does-not-exist.db"));
eq(empty.sources.length, 0, "Missing cache must yield an empty report.");
eq(empty.years.length, 0, "Missing cache must yield no year axis.");

// Seed two sources across non-overlapping years, one metric-heavy.
const recordRoot = path.join(tmp, "record");
fs.mkdirSync(path.join(recordRoot, "daily"), { recursive: true });
// alpha: 3 dates × 2 metrics = 6 rows; years 2020 (4) and 2022 (2), 3 distinct days.
fs.writeFileSync(
  path.join(recordRoot, "daily", "alpha.csv"),
  "date,x,y\n2020-01-01,1,2\n2020-06-01,3,4\n2022-03-01,5,6\n",
);
// beta: 2 dates × 1 metric = 2 rows; year 2021 only, 2 distinct days.
fs.writeFileSync(path.join(recordRoot, "daily", "beta.csv"), "date,z\n2021-05-05,9\n2021-05-06,8\n");
writeConfig({ username: "test", createdAt: new Date().toISOString() } as never);
rebuild({ recordDir: recordRoot, dbPath: dbPath() });

const r = buildCoverage(dbPath());

// Year axis spans the earliest..latest source, every year in between.
eq(r.years, [2020, 2021, 2022], "Year axis must be a continuous 2020..2022 range.");

// Richest source first.
eq(r.sources.map((s) => s.source), ["alpha", "beta"], "Sources must be sorted by total rows, richest first.");

const alpha = r.sources[0];
eq(alpha.rows, 6, "alpha total rows.");
eq(alpha.days, 3, "alpha distinct days.");
eq(alpha.byYear, { "2020": 4, "2022": 2 }, "alpha per-year histogram (only years with data).");
eq(alpha.first, "2020-01-01", "alpha first date.");
eq(alpha.last, "2022-03-01", "alpha last date.");

const beta = r.sources[1];
eq(beta.byYear, { "2021": 2 }, "beta per-year histogram.");

// Record totals.
eq(r.totalRows, 8, "Total rows across the record.");
eq(r.totalDays, 5, "Distinct days across the record.");
eq(r.span, { first: "2020-01-01", last: "2022-03-01" }, "Record span.");

// ---- graph series ---------------------------------------------------------
// The Graphs tab reads THIS, not the journal. It used to pull the full journal
// payload — every cell wrapped in an object, plus per-day memos/sessions/events
// it never looked at — which on a lifetime record is a body too large for Chrome
// to file in its HTTP cache: the fetch came back ERR_CACHE_WRITE_FAILURE and the
// tab sat on its skeleton. What is asserted here is the compact wire shape and
// that it still carries exactly the numbers the charts plot.
const g = readGraphSeries({ file: dbPath(), today: "2026-01-01" });
eq(g.dates, ["2020-01-01", "2020-06-01", "2021-05-05", "2021-05-06", "2022-03-01"], "Shared date axis, ascending.");
eq(g.totalDays, 5, "Series report carries the full-history day count.");

const byKey = new Map(g.series.map((s) => [s.key, s]));
// A metric is SPARSE: `d` indexes the shared axis, so a column recorded on 3 of 5
// days ships 3 values, not 5.
const alphaX = byKey.get("metric:alpha.x")!;
eq(alphaX.label, "alpha · x", "Metric series label.");
eq(alphaX.d, [0, 1, 4], "Sparse metric series indexes only the days it has.");
eq(alphaX.v, [1, 3, 5], "Sparse metric series carries its values in date order.");
eq(byKey.get("metric:beta.z")!.d, [2, 3], "beta.z lands on its own two days.");

// A count is DENSE and carries no index array: zero IS the answer on a day with
// nothing, and a hole in the line would read as missing data instead of none.
const points = byKey.get("count:data-points")!;
eq(points.d, undefined, "Dense count series omits the index array.");
eq(points.v, [2, 2, 1, 1, 2], "Cells per day across the whole record.");
eq(byKey.get("count:logs")!.v, [0, 0, 0, 0, 0], "No memos in this record — zeros, not gaps.");
eq(byKey.get("count:source:alpha")!.v, [2, 2, 0, 0, 2], "Per-source cells per day, zero where the source is silent.");
eq(
  byKey.get("count:activity")!.v,
  [2, 2, 1, 1, 2],
  "Activity = cells + memos + sessions.",
);

// Text cells are not plottable, so they never reach the wire — but they still
// count as data points, which is what the Graphs count series has always meant.
fs.writeFileSync(path.join(recordRoot, "daily", "notes.csv"), "date,note\n2020-01-01,a long enough note\n");
rebuild({ recordDir: recordRoot, dbPath: dbPath() });
const g2 = readGraphSeries({ file: dbPath(), today: "2026-01-01" });
eq(
  g2.series.some((s) => s.key === "metric:notes.note"),
  false,
  "A non-numeric column is not a plottable series.",
);
eq(
  new Map(g2.series.map((s) => [s.key, s])).get("count:data-points")!.v[0],
  3,
  "…but it still counts as a data point on its day.",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ coverage-test passed");
