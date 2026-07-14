#!/usr/bin/env tsx
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pipeline-"));
// Pin all paths to the temp data dir before anything resolves them.
process.env.AGENTQS_DATA_DIR = tmp;

import Database from "better-sqlite3";
import { connectionState, resolveCredentialWithOrigin, resolveSyncCredential, type ImporterPlugin } from "../src/lib/importers/plugin";
import { coverageBySource } from "../src/lib/daily";
import { pipelineReport, detectScheduler } from "../src/lib/pipeline";
import { buildSources } from "../src/lib/source-registry";
import { readSyncRuns, recordDueRun, recordSyncRun } from "../src/lib/sync-runs";
import { readConfig, writeConfig, type AppConfig } from "../src/lib/config";
import { rebuild } from "../src/lib/record";
import { dbPath } from "../src/lib/paths";

// --- credential provenance: each origin is reported, precedence preserved.
const fakePlugin = {
  id: "fakeapi",
  name: "Fake API",
  detail: "",
  credentialLabel: "token",
  requiresCredential: true,
  live: true,
  envKey: "AGENTQS_FAKEAPI_TOKEN",
  discoverCredential: () => "desktop-token",
  fetch: async () => ({ from: "", to: "", daysWithData: 0, metrics: [], cells: 0 }),
} as unknown as ImporterPlugin;

const cfgNone = null;
const discovered = resolveCredentialWithOrigin(fakePlugin, undefined, cfgNone);
if (discovered.origin !== "discovered" || discovered.credential !== "desktop-token")
  throw new Error(`Desktop-app token must report origin "discovered", got ${JSON.stringify(discovered)}`);

const cfgSaved = { sourceCreds: { fakeapi: "pasted" } } as unknown as AppConfig;
const saved = resolveCredentialWithOrigin(fakePlugin, undefined, cfgSaved);
if (saved.origin !== "saved" || saved.credential !== "pasted")
  throw new Error(`A user-saved credential must win over discovery and report "saved", got ${JSON.stringify(saved)}`);

process.env.AGENTQS_FAKEAPI_TOKEN = "env-token";
const env = resolveCredentialWithOrigin(fakePlugin, undefined, cfgSaved);
if (env.origin !== "env") throw new Error(`Env var must win over saved and report "env", got ${JSON.stringify(env)}`);
delete process.env.AGENTQS_FAKEAPI_TOKEN;

const explicit = resolveCredentialWithOrigin(fakePlugin, "direct", cfgSaved);
if (explicit.origin !== "explicit") throw new Error(`Explicit credential must report "explicit"`);

// --- THE rule: connected ⇔ a stored credential. A detected desktop-app login
// is a hint only — it never syncs, and nothing keyless can flip connected.
const detectedOnly = connectionState(fakePlugin, null);
if (detectedOnly.connected) throw new Error("A detected desktop-app token must NEVER count as connected.");
if (!detectedOnly.detectedApp) throw new Error("The detected app must be reported as a hint.");
if (resolveSyncCredential(fakePlugin, undefined, null) !== undefined)
  throw new Error("Sync must NEVER use a discovered token.");

// The only path: the explicit connect that IMPORTS the token as a saved
// credential — after which connected is true because a credential is stored.
const cfgImported = { sourceCreds: { fakeapi: "desktop-token" } } as unknown as AppConfig;
const imported = connectionState(fakePlugin, cfgImported);
if (!imported.connected || imported.credentialOrigin !== "saved")
  throw new Error(`An imported token is a saved credential: ${JSON.stringify(imported)}`);
if (resolveSyncCredential(fakePlugin, undefined, cfgImported) !== "desktop-token")
  throw new Error("Sync must use the saved credential.");

// data presence never implies connected
const dataFile = path.join(tmp, "fake-daily.csv");
fs.writeFileSync(dataFile, "date,v\n2026-01-01,1\n");
const dataOnly = connectionState(fakePlugin, null, "fakeapi", dataFile);
if (dataOnly.connected) throw new Error("Imported data must never present a source as connected.");
if (!dataOnly.hasData) throw new Error("hasData must reflect record rows.");

// --- run ledger: failures recorded, dueness heartbeat stamped, corrupt file degrades.
recordSyncRun("spotify", false, "boom: token expired\nsecond line ignored");
recordSyncRun("github", true);
recordDueRun();
const runs = readSyncRuns();
if (runs.runs.spotify?.ok !== false || runs.runs.spotify?.error !== "boom: token expired")
  throw new Error(`Failure not ledgered correctly: ${JSON.stringify(runs.runs.spotify)}`);
if (runs.runs.github?.ok !== true) throw new Error("Success not ledgered.");
if (!runs.dueRunAt) throw new Error("Due-run heartbeat not stamped.");
fs.writeFileSync(path.join(tmp, "sync-runs.json"), "{corrupt");
if (Object.keys(readSyncRuns().runs).length !== 0) throw new Error("Corrupt ledger must degrade to empty, not throw.");
recordSyncRun("spotify", false, "boom: token expired");

// --- pipeline report: sources carry provenance + ledger; scheduler detection is
// home-scoped so the report never claims another machine's launchd agents.
writeConfig({
  username: "t",
  passwordHash: "x",
  sessionSecret: "s",
  createdAt: new Date().toISOString(),
  sourceCreds: { spotify: "tok" },
  sourceIntervals: { spotify: "daily" },
  sourceSyncedAt: { spotify: "2020-01-01T00:00:00.000Z" },
} as unknown as AppConfig);

const report = pipelineReport(path.join(tmp, "record"));
const spotify = report.sources.find((s) => s.id === "spotify");
if (!spotify) throw new Error("spotify missing from pipeline report.");
if (spotify.credentialOrigin !== "saved") throw new Error(`Expected saved credential, got ${spotify.credentialOrigin}`);
if (!spotify.scheduled || spotify.interval !== "daily") throw new Error("Schedule not reported.");
if (spotify.lastRun?.ok !== false || !spotify.lastRun.error?.startsWith("boom"))
  throw new Error(`Ledgered failure missing from report: ${JSON.stringify(spotify.lastRun)}`);

const google = report.sources.find((s) => s.id === "google_activity_all");
if (!google || google.origin !== "extension") throw new Error("Chrome-extension presets missing from the pipeline.");

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pipeline-home-"));
const sched = detectScheduler(emptyHome);
if (sched.launchd !== false) throw new Error("Scheduler detection must be home-scoped (empty home => no launchd).");

// --- "what synced, and which account?" — every row carries the coverage the
// Pipeline tab shows, and a WHOOP instance names the athlete it is authorized as.
// Without these a connected-but-empty source renders identically to a healthy one,
// and two WHOOP accounts are indistinguishable twins.
const recordRoot = path.join(tmp, "record");
fs.mkdirSync(path.join(recordRoot, "daily"), { recursive: true });
fs.writeFileSync(
  path.join(recordRoot, "daily", "whoop.csv"),
  "date,recovery,hrv\n2026-06-01,68,55\n2026-06-02,41,33\n",
);
fs.writeFileSync(path.join(recordRoot, "daily", "whoop-2.csv"), "date,recovery\n2026-06-01,55\n");
writeConfig({
  username: "t",
  passwordHash: "x",
  sessionSecret: "s",
  createdAt: new Date().toISOString(),
  whoopCreds: { email: "athlete@example.com", password: "p" },
  whoopCredsByInstance: { "whoop-2": { email: "second@example.com", password: "p" } },
} as unknown as AppConfig);
rebuild({ recordDir: recordRoot, dbPath: dbPath() });

const rows = buildSources(readConfig(), recordRoot);
const whoop = rows.find((s) => s.id === "whoop");
const whoop2 = rows.find((s) => s.id === "whoop-2");
if (!whoop || !whoop2) throw new Error("Both WHOOP accounts must have rows.");
if (whoop.coverage?.days !== 2 || whoop.coverage.from !== "2026-06-01" || whoop.coverage.to !== "2026-06-02")
  throw new Error(`WHOOP coverage must count what landed, got ${JSON.stringify(whoop.coverage)}`);
if (whoop2.coverage?.days !== 1)
  throw new Error(`whoop-2 coverage must be its OWN, got ${JSON.stringify(whoop2.coverage)}`);
if (whoop.account !== "athlete@example.com" || whoop2.account !== "second@example.com")
  throw new Error(`Each WHOOP row must name its athlete, got ${whoop.account} / ${whoop2.account}`);

// A connected source that landed NOTHING must say so — zeroed coverage, never absent.
const github = rows.find((s) => s.id === "github");
if (!github?.coverage || github.coverage.days !== 0 || github.coverage.events !== 0)
  throw new Error(`An empty source must report zeroed coverage, got ${JSON.stringify(github?.coverage)}`);

// --- THE rule, at the row level: data you IMPORTED is never a connection.
// A CSV dropped into record/daily used to build a row with connected: true, so the
// user's own files read back as live, authorized integrations ("it says connected —
// connected to WHAT?"). It has no credential and nothing syncs it: it is `imported`.
fs.writeFileSync(path.join(recordRoot, "daily", "mood_journal.csv"), "date,mood\n2026-06-01,7\n");
const withDrop = buildSources(readConfig(), recordRoot);
const dropped = withDrop.find((s) => s.id === "mood_journal");
if (!dropped) throw new Error("A dropped CSV must still surface as a row (removable, filterable).");
if (dropped.connected)
  throw new Error("A dropped CSV must NEVER be connected — data in the record is not a credential.");
if (dropped.provenance !== "imported")
  throw new Error(`A dropped CSV must report provenance "imported", got ${dropped.provenance}`);
if (!dropped.hasData) throw new Error("A dropped CSV with rows must still report hasData (it is filterable).");

// WHOOP, which DOES hold a credential, is the only kind of row that may claim it.
if (!whoop.connected || whoop.provenance !== "credential")
  throw new Error(`A credential-backed source must be connected, got ${whoop.provenance}`);

// And the pipeline report must tell the same story the tab does.
const rep = pipelineReport(recordRoot).sources;
const repDrop = rep.find((s) => s.id === "mood_journal");
if (repDrop?.connected || repDrop?.provenance !== "imported")
  throw new Error(`pipeline must report a dropped CSV as imported, got ${JSON.stringify(repDrop)}`);
const repGoogle = rep.find((s) => s.id === "google_activity_all");
if (repGoogle?.connected)
  throw new Error("An extension scrape is imported data, never a connection.");

// --- Coverage may never full-scan the events table. Every Pipeline row hangs off
// coverageBySource, and SQLite here is SYNCHRONOUS: on a real record (1.5M events,
// a 1.3GB cache) an uncovered GROUP BY spent seconds fetching every row just to
// read its date — it timed the Sources list out AND froze the whole server thread
// while it ran. Assert the PLAN, not the clock: a wall-time budget is flaky on a
// loaded machine and passes on a toy record no matter how bad the query is.
const dropIdx = new Database(dbPath());
dropIdx.exec("DROP INDEX IF EXISTS events_source_date; DROP INDEX IF EXISTS daily_source_date;");
dropIdx.close();

// A cache built by an OLDER version arrives without them, and a full rebuild costs
// minutes — so the read path must heal it in place. This call is that migration.
coverageBySource(dbPath());

const planDb = new Database(dbPath(), { readonly: true });
for (const [table, sql] of [
  ["events", "SELECT source, COUNT(*) n, MIN(date) f, MAX(date) t FROM events GROUP BY source"],
  ["daily", "SELECT source, COUNT(DISTINCT date) d, MIN(date) f, MAX(date) t FROM daily GROUP BY source"],
] as const) {
  const plan = (planDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");
  if (!/COVERING INDEX \w*source_date/.test(plan))
    throw new Error(`coverage over ${table} must be answered from a covering (source, date) index, got: ${plan}`);
}
planDb.close();

console.log("pipeline-test: PASS");
