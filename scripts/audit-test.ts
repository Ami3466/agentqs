#!/usr/bin/env tsx
/**
 * Ships-when proof for the index audit (deterministic evidence for AI review).
 *
 *   MAIN: auditIndex reads the rebuilt cache and flags — with evidence — the
 *   shapes that rot a record: impossible dates, single-day sources gone quiet,
 *   coverage holes in steady sources, sources that fell silent, and numeric
 *   outliers. Clean data produces zero findings; it never mutates anything.
 *
 * Drives production code against a temp AGENTQS_DATA_DIR — no network.
 * Run: npm run audit:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-audit-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { auditIndex } from "../src/lib/audit";
import { mergeDailyCsv, rebuild } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const rDir = recordDir();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

// steady source: daily rows for 120 days up to ~100 days ago, then a 51-day
// hole, then a short stretch that stops 45 days ago → coverage gap AND stale.
const steady: string[][] = [];
for (let i = 220; i > 100; i--) steady.push([daysAgo(i), "60"]);
for (let i = 50; i >= 45; i--) steady.push([daysAgo(i), "61"]);
mergeDailyCsv(rDir, "steady_hr", { header: ["date", "resting_hr"], rows: steady });

// epoch bug + far-future typo
mergeDailyCsv(rDir, "buggy", {
  header: ["date", "x"],
  rows: [["1970-01-01", "0"], ["2093-05-01", "1"], [daysAgo(10), "2"]],
});

// single-day source, long silent
mergeDailyCsv(rDir, "labs", { header: ["date", "hb"], rows: [[daysAgo(200), "15.1"]] });

// outlier: steps with one 100× cell (a rollup landing on one day)
const steps: string[][] = [];
for (let i = 40; i > 1; i--) steps.push([daysAgo(i), "8000"]);
steps.push([daysAgo(1), "900000"]);
mergeDailyCsv(rDir, "walker", { header: ["date", "steps"], rows: steps });

// clean recent source — must produce NO findings
const clean: string[][] = [];
for (let i = 30; i >= 1; i--) clean.push([daysAgo(i), "7.5"]);
mergeDailyCsv(rDir, "clean_sleep", { header: ["date", "hours"], rows: clean });

rebuild({ recordDir: rDir });

console.log("\nauditIndex evidence");
const report = auditIndex();
const of = (kind: string, source: string) => report.findings.find((f) => f.kind === kind && f.source === source);

check("impossible dates flagged with both cells", (of("impossible-date", "buggy")?.evidence.length ?? 0) === 2, JSON.stringify(of("impossible-date", "buggy")?.evidence));
check("single-day source flagged", !!of("single-day-source", "labs"), of("single-day-source", "labs")?.detail);
check("coverage hole found in steady source", !!of("coverage-gap", "steady_hr"), of("coverage-gap", "steady_hr")?.evidence.join("; "));
check("gone-quiet source flagged", !!of("stale-source", "steady_hr"), of("stale-source", "steady_hr")?.detail);
check("outlier cell named with its date", !!of("outlier-values", "walker")?.evidence[0]?.includes("900000"), JSON.stringify(of("outlier-values", "walker")?.evidence));
check("clean source produces nothing", !report.findings.some((f) => f.source === "clean_sleep"));
check("counts add up", Object.values(report.counts).reduce((a, b) => a + b, 0) === report.findings.length);

// read-only: a second run returns identical evidence
const again = auditIndex();
check("read-only and deterministic", JSON.stringify(again) === JSON.stringify(report));

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
