#!/usr/bin/env tsx
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-pipeline-"));
// Pin all paths to the temp data dir before anything resolves them.
process.env.AGENTQS_DATA_DIR = tmp;

import { connectionState, resolveCredentialWithOrigin, resolveSyncCredential, type ImporterPlugin } from "../src/lib/importers/plugin";
import { pipelineReport, detectScheduler } from "../src/lib/pipeline";
import { readSyncRuns, recordDueRun, recordSyncRun } from "../src/lib/sync-runs";
import { writeConfig, type AppConfig } from "../src/lib/config";

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

console.log("pipeline-test: PASS");
