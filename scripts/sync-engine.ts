/**
 * Ships-when proof for Loop 10 · Data tab (sync engine).
 *
 *   1. Set "GitHub: daily" and, on reopen, it is DUE → the Data tab auto-syncs it.
 *   2. A real manual importer (Chrome) that has fallen behind its interval shows a
 *      STALE badge — and a one-off dropped CSV is NOT surfaced as a source at all.
 *
 * Drives the real engine (buildSources + isDue/isStale) against a throwaway
 * record with controlled file mtimes / sync timestamps — deterministic, offline,
 * no network. Run: npm run sync:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import { buildSources } from "../src/lib/source-registry";
import { isDue, isStale } from "../src/lib/sources";
import type { AppConfig } from "../src/lib/config";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures++;
}

function daysAgoISO(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-sync-"));
const dailyDir = path.join(root, "daily");
fs.mkdirSync(dailyDir, { recursive: true });

// A live api source (GitHub), a real manual file importer (Chrome history), and a
// one-off dropped CSV ("mood") that must NOT masquerade as a connected source.
fs.writeFileSync(path.join(dailyDir, "github.csv"), "date,commits\n2026-07-01,5\n2026-07-02,3\n");
fs.writeFileSync(path.join(dailyDir, "chrome.csv"), "date,visits\n2026-07-01,42\n");
fs.writeFileSync(path.join(dailyDir, "mood.csv"), "date,mood\n2026-07-01,7\n");

// Backdate the manual importer's file 2 days so a "daily" cadence is overdue.
const twoDaysSec = Date.now() / 1000 - 2 * 86_400;
fs.utimesSync(path.join(dailyDir, "chrome.csv"), twoDaysSec, twoDaysSec);

// A token must be resolvable for GitHub to be auto-syncable (`due`).
process.env.GITHUB_TOKEN = "ghp_shipswhen_test";

const base: AppConfig = {
  username: "tester",
  passwordHash: "",
  sessionSecret: "",
  llmProvider: "",
  llmKey: "",
  model: "",
  theme: "system",
  createdAt: new Date().toISOString(),
};

console.log("\nScenario 1 — GitHub: daily, last synced 2 days ago → due on reopen");
const cfg1: AppConfig = {
  ...base,
  githubSyncedAt: daysAgoISO(2),
  sourceIntervals: { github: "daily", chrome: "daily", mood: "daily" },
};
const s1 = buildSources(cfg1, root);
const gh1 = s1.find((s) => s.id === "github")!;
const chrome1 = s1.find((s) => s.id === "chrome")!;
check("GitHub is an api source, connected", gh1.kind === "api" && gh1.connected);
check("GitHub interval persisted as daily", gh1.interval === "daily");
check("GitHub is DUE → auto-syncs on open", gh1.due === true);
check("GitHub exposes a sync endpoint", gh1.syncEndpoint === "/api/import/github");

console.log("\nScenario 2 — a real manual importer badges stale; a dropped CSV is not a source");
check("Chrome is a manual source, connected", chrome1.kind === "manual" && chrome1.connected);
check("Chrome is STALE (no data within its daily interval)", chrome1.stale === true);
check("a manual source is never 'due' (can't auto-sync)", chrome1.due === false);
check(
  "a one-off dropped 'mood' CSV is NOT surfaced as a source",
  s1.every((s) => s.id !== "mood"),
);

console.log("\nScenario 3 — freshly synced GitHub is not due; interval off clears due");
const cfg3a: AppConfig = { ...cfg1, githubSyncedAt: new Date().toISOString() };
const gh3a = buildSources(cfg3a, root).find((s) => s.id === "github")!;
check("GitHub synced just now → NOT due", gh3a.due === false);

const cfg3b: AppConfig = { ...base, githubSyncedAt: daysAgoISO(5), sourceIntervals: {} };
const s3b = buildSources(cfg3b, root);
check("interval off → GitHub not due", s3b.find((s) => s.id === "github")!.due === false);
check("interval off → Chrome not stale", s3b.find((s) => s.id === "chrome")!.stale === false);

console.log("\nScenario 4 — pure helpers");
check("isDue(2d ago, daily) === true", isDue(daysAgoISO(2), "daily") === true);
check("isDue(just now, daily) === false", isDue(new Date().toISOString(), "daily") === false);
check("isDue(never, daily) === true (seed on first open)", isDue(null, "daily") === true);
check("isStale(2d ago, daily) === true", isStale(daysAgoISO(2), "daily") === true);
check("isStale(never, daily) === false (not connected, not stale)", isStale(null, "daily") === false);
check("isStale(2d ago, off) === false", isStale(daysAgoISO(2), "off") === false);

fs.rmSync(root, { recursive: true, force: true });

if (failures) {
  console.log(`\n✗ ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log("\n✓ Sync engine ships: GitHub daily auto-syncs on open; stale manual source badges.\n");
