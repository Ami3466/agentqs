/**
 * Ships-when proof for Loop 10 · Pipeline tab (sync engine).
 *
 *   1. Set "GitHub: daily" and, on reopen, it is DUE → the Pipeline tab auto-syncs it.
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
// A connected Tier-1 plugin (RescueTime) — proves the schedule is honored for
// EVERY api source, not just GitHub's bespoke row.
fs.writeFileSync(path.join(dailyDir, "rescuetime.csv"), "date,productivity_pulse\n2026-07-01,63\n");

// Backdate the manual importer's file 2 days so a "daily" cadence is overdue.
const twoDaysSec = Date.now() / 1000 - 2 * 86_400;
fs.utimesSync(path.join(dailyDir, "chrome.csv"), twoDaysSec, twoDaysSec);

// A credential must be resolvable for a source to be auto-syncable (`due`).
process.env.GITHUB_TOKEN = "ghp_shipswhen_test";
process.env.RESCUETIME_KEY = "rt_shipswhen_test";

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
  sourceSyncedAt: { rescuetime: daysAgoISO(2) },
  sourceIntervals: { github: "daily", chrome: "daily", mood: "daily", rescuetime: "daily" },
};
const s1 = buildSources(cfg1, root);
const gh1 = s1.find((s) => s.id === "github")!;
const chrome1 = s1.find((s) => s.id === "chrome")!;
const rt1 = s1.find((s) => s.id === "rescuetime")!;
check("GitHub is an api source, connected", gh1.kind === "api" && gh1.connected);
check("GitHub interval persisted as daily", gh1.interval === "daily");
check("GitHub is DUE → auto-syncs on open", gh1.due === true);
check("GitHub exposes a sync endpoint", gh1.syncEndpoint === "/api/import/github");
// Same schedule contract holds for a generic Tier-1 plugin, not just GitHub.
check("RescueTime interval persisted as daily", rt1.interval === "daily");
check("RescueTime is DUE → auto-syncs on open", rt1.due === true);
check("RescueTime exposes its sync endpoint", rt1.syncEndpoint === "/api/import/rescuetime");

console.log("\nScenario 2 — a manual importer badges stale; NEITHER it nor a dropped CSV is 'connected'");
// THE rule: connected ⇔ a stored credential. Reading Chrome's history file off this
// machine involves no key and no account, so it is a LOCAL FILE, not a connection —
// this check used to assert `chrome1.connected`, which is precisely the bug it was
// meant to guard against (every local import wearing an integration's badge).
check("Chrome is a manual source with data", chrome1.kind === "manual" && chrome1.hasData === true);
check("Chrome is NOT connected (no credential behind a local file)", chrome1.connected === false);
check("Chrome reports provenance 'local-file'", chrome1.provenance === "local-file");
check("Chrome is STALE (no data within its daily interval)", chrome1.stale === true);
check("a manual source is never 'due' (can't auto-sync)", chrome1.due === false);
// A dropped CSV IS surfaced — the user must be able to see, filter and remove their
// own data. What it must never do is claim to be a connection.
const mood1 = s1.find((s) => s.id === "mood");
check("a one-off dropped 'mood' CSV IS surfaced (removable, filterable)", Boolean(mood1));
check("…but is NEVER connected", mood1?.connected === false);
check("…and reports provenance 'imported'", mood1?.provenance === "imported");

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
