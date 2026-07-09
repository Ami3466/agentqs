#!/usr/bin/env tsx
import fs from "fs";
import os from "os";
import path from "path";
import { ingestGoogleActivityApiItems } from "../src/lib/google-web-scraper";
import { readEventsFromRecord, rebuild } from "../src/lib/record";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-google-activity-"));
// Pin the whole process to the temp data dir: even a code path that falls back
// to default paths (the bug that once vacuumed this test's 2 fixture events over
// the real cache) can then only touch the temp dir.
process.env.AGENTQS_DATA_DIR = tmp;
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

console.log("google-activity-extension-test: PASS");
