#!/usr/bin/env tsx
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-google-activity-"));
// Pin the whole process to the temp data dir: even a code path that falls back
// to default paths (the bug that once vacuumed this test's 2 fixture events over
// the real cache) can then only touch the temp dir.
process.env.AGENTQS_DATA_DIR = tmp;
// A random high port so this test never collides with a running agentqs.
// (paths and ports are resolved at call time, so setting env here is safe
// even though the imports below are static.)
process.env.AGENTQS_INGEST_PORT = String(30000 + Math.floor(Math.random() * 20000));

import { extensionLatestVersion, extensionPingFile, GOOGLE_PRESETS, ingestGoogleActivityApiItems } from "../src/lib/google-web-scraper";
import { INGEST_PATH, INGEST_PING_PATH, ingestPort, startIngestServer } from "../src/lib/ingest-server";
import { readEventsFromRecord, rebuild } from "../src/lib/record";

const recordDir = path.join(tmp, "record");

const MICROS = 1783382580000000; // 2026-07-06T00:03:00Z
const item = [
  "Search",
  "Searched for agentqs lifetime browser history",
  "https://example.com/history",
  MICROS,
];

// Events bucket by the machine's LOCAL day (the journal is local-first), so the
// expected date is computed the same way — never hardcoded, which breaks in any
// timezone other than the author's.
function isoLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const expectedDate = isoLocalDate(new Date(MICROS / 1000));

const res = ingestGoogleActivityApiItems({
  preset: "browser_history",
  items: [item],
  final: true,
  rDir: recordDir,
});

const events = readEventsFromRecord(recordDir);
console.log(JSON.stringify({ result: res, event: events[0] }, null, 2));

if (res.events !== 1) throw new Error(`Expected 1 parsed event, got ${res.events}`);
if (res.added !== 1) throw new Error(`Expected 1 added event, got ${res.added}`);
if (events[0]?.date !== expectedDate) throw new Error(`Bad event date: ${events[0]?.date} (expected ${expectedDate})`);
if (events[0]?.ts !== new Date(MICROS / 1000).toISOString()) throw new Error(`Bad event ts: ${events[0]?.ts}`);
if (!events[0]?.text.includes("agentqs lifetime browser history")) throw new Error("Missing event text.");

// DOM presets (Timeline) post plain text blocks — the date must come from the
// block's own text, never the import-run timestamp.
const blockRes = ingestGoogleActivityApiItems({
  preset: "google_timeline",
  items: ["Visited Blue Bottle Coffee\nJan 5, 2024 · 10:30 AM\nOakland, CA"],
  final: true,
  rDir: recordDir,
});
const blockEvents = readEventsFromRecord(recordDir).filter((e) => e.source === "google_timeline_scrape");
if (blockRes.events !== 1) throw new Error(`Expected 1 parsed block event, got ${blockRes.events}`);
if (blockEvents[0]?.date !== "2024-01-05") throw new Error(`Block event dated by run time, not text: ${blockEvents[0]?.date}`);

// Regression: a rebuild fed a temp record must write its cache NEXT TO that
// record — never over the default data dir's cache. (This bug once vacuumed a
// 2-fixture-event temp record over the real cache on every test run.)
const cacheBefore = fs.readFileSync(path.join(tmp, "agentqs.db"));
const isoTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-google-activity-iso-"));
const isoRecord = path.join(isoTmp, "record");
fs.mkdirSync(path.join(isoRecord, "daily"), { recursive: true });
fs.writeFileSync(path.join(isoRecord, "daily", "iso.csv"), "date,v\n2026-01-01,1\n");
const isoRes = rebuild({ recordDir: isoRecord });
if (isoRes.dbPath !== path.join(isoTmp, "agentqs.db"))
  throw new Error(`Temp-record rebuild wrote its cache to ${isoRes.dbPath} — must land beside the record.`);
if (!fs.existsSync(path.join(isoTmp, "agentqs.db"))) throw new Error("Temp-record rebuild produced no cache.");
if (!cacheBefore.equals(fs.readFileSync(path.join(tmp, "agentqs.db"))))
  throw new Error("Temp-record rebuild MODIFIED the default data dir's cache — isolation regression.");

// --- Extension bundle sanity: valid JS, and the importer lists (canonical
// GOOGLE_PRESETS, background.js, content.js) cannot drift apart.
const extDir = path.join(__dirname, "..", "extensions", "google-activity-exporter");
for (const file of ["background.js", "content.js", "popup.js"]) {
  const check = spawnSync("node", ["--check", path.join(extDir, file)], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`node --check ${file} failed: ${check.stderr}`);
}
const canonical = GOOGLE_PRESETS.map((p) => p.id).sort().join(",");
const backgroundJs = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
const contentJs = fs.readFileSync(path.join(extDir, "content.js"), "utf8");
const backgroundIds = [...backgroundJs.matchAll(/\{ id: "([a-z_]+)", label:/g)].map((m) => m[1]).sort().join(",");
const contentIds = [
  ...[...contentJs.matchAll(/myActivityImporter\("([a-z_]+)"/g)].map((m) => m[1]),
  ...[...contentJs.matchAll(/^\s+id: "([a-z_]+)",$/gm)].map((m) => m[1]),
].sort().join(",");
if (backgroundIds !== canonical) throw new Error(`background.js importers drifted from GOOGLE_PRESETS:\n${backgroundIds}\n${canonical}`);
if (contentIds !== canonical) throw new Error(`content.js importers drifted from GOOGLE_PRESETS:\n${contentIds}\n${canonical}`);
// The checkpoint key must match between the writer (content.js) and the
// watchdog reader (background.js).
const resumeKeyOf = (src: string) => src.match(/RESUME_KEY = "([^"]+)"/)?.[1];
if (!resumeKeyOf(contentJs) || resumeKeyOf(contentJs) !== resumeKeyOf(backgroundJs))
  throw new Error(`RESUME_KEY drifted: content=${resumeKeyOf(contentJs)} background=${resumeKeyOf(backgroundJs)}`);

// The downloadable zip must ship the same version as the source folder — a
// stale zip strands every unpacked install on old code with no signal (the
// Data tab's update hint compares against extensionLatestVersion()).
const manifestVersion = (JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8")) as { version: string }).version;
if (extensionLatestVersion() !== manifestVersion)
  throw new Error(`extensionLatestVersion() ${extensionLatestVersion()} != manifest ${manifestVersion}`);
const zipPath = path.join(__dirname, "..", "public", "downloads", "agentqs-google-activity-exporter.zip");
const zipManifest = spawnSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" });
if (zipManifest.status !== 0) throw new Error(`Cannot read manifest from ${zipPath}: ${zipManifest.stderr}`);
const zipVersion = (JSON.parse(zipManifest.stdout) as { version: string }).version;
if (zipVersion !== manifestVersion)
  throw new Error(`Shipped zip is v${zipVersion} but the extension source is v${manifestVersion} — rebuild the zip.`);

// --- Standalone ingest listener: the extension's recompile-proof sink. Drives
// the real HTTP server (loopback only): ping heartbeat + a batch post.
async function listenerTest(): Promise<void> {
  startIngestServer();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const base = `http://127.0.0.1:${ingestPort()}`;
  const origin = { origin: "https://myactivity.google.com", "content-type": "application/json" };

  const pingRes = await fetch(`${base}${INGEST_PING_PATH}`, {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ version: "test-0.0.0" }),
  });
  if (!pingRes.ok) throw new Error(`Listener ping returned ${pingRes.status}`);
  const ping = JSON.parse(fs.readFileSync(extensionPingFile(), "utf8")) as { version?: string; seenAt?: string };
  if (ping.version !== "test-0.0.0" || !ping.seenAt) throw new Error(`Ping file not stamped: ${JSON.stringify(ping)}`);

  const noOrigin = await fetch(`${base}${INGEST_PING_PATH}`, { method: "POST", body: "{}" });
  if (noOrigin.status !== 403) throw new Error(`Originless ping must be rejected, got ${noOrigin.status}`);

  const batchRes = await fetch(`${base}${INGEST_PATH}`, {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ preset: "browser_history", items: [item], page: 2, ct: "tok", final: false }),
  });
  const batchBody = (await batchRes.json()) as { ok?: boolean; result?: { added?: number } };
  if (!batchRes.ok || batchBody.ok !== true) throw new Error(`Listener ingest failed: ${batchRes.status} ${JSON.stringify(batchBody)}`);
  if (batchBody.result?.added !== 0) throw new Error(`Re-posted batch must dedup to 0 added (resume safety), got ${batchBody.result?.added}`);
}

listenerTest()
  .then(() => {
    console.log("google-activity-extension-test: PASS");
    process.exit(0); // the ingest listener holds the event loop open
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
