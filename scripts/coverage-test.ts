#!/usr/bin/env tsx
/**
 * Coverage test — drives the real buildCoverage() over a rebuilt cache in a temp
 * data dir. No network. Exits 1 on any mismatch. Mirrors the record.rebuild() path
 * so it proves the same brain the Overview tab, /api/coverage, CLI and MCP all call.
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓ coverage-test passed");
