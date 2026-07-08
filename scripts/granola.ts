#!/usr/bin/env tsx
/**
 * Granola importer proof. Drives the real plugin end to end against the offline
 * fixture (samples/granola-documents.json) — refresh token → access token →
 * documents → panels → transcript → daily table + searchable text + journal
 * events — and asserts the things that were actually wrong when this was built:
 *
 *   · Granola's onboarding document ships a calendar block spanning a WEEK.
 *     Trusting it reported a 10,155-minute meeting day. It is a note, not a meeting.
 *   · The calendar block is the *plan*; the transcript is what happened. A 30-minute
 *     block that overran to 46 minutes is 46 minutes.
 *   · Re-syncing must add nothing — events are keyed by Granola's document id.
 *
 * Deterministic, no network. Run: npm run granola:test
 * With a signed-in Granola desktop app, `--live` also does one real read-only sync
 * into a temp record dir, proving the credential discovery + real API shapes.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { granolaPlugin } from "../src/lib/importers/granola";
import { importPlugin, resolveCredential, type FetchLike } from "../src/lib/importers/plugin";
import {
  MAX_MEETING_MINUTES,
  discoverGranolaRefreshToken,
  panelToText,
  resetGranolaAuthCache,
  transcriptToText,
} from "../src/lib/granola";
import { parseCsv } from "../src/lib/record";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const MEETING_ID = "11111111-2222-3333-4444-555555555555";
const NOTE_ID = "77777777-7777-7777-7777-777777777777";

type Fixture = Record<string, any>;

/** The fixture Granola API: routes by endpoint, then by posted document_id. */
function fixtureFetch(fx: Fixture): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const req = init?.body ? JSON.parse(String(init.body)) : {};
    let payload: unknown = {};
    if (href.includes("refresh-access-token")) payload = fx.refresh;
    else if (href.includes("get-documents")) payload = fx.documents;
    else if (href.includes("get-document-panels")) payload = fx.panels[req.document_id] ?? [];
    else if (href.includes("get-document-transcript")) payload = fx.transcript[req.document_id] ?? [];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;
}

function readCsv(dir: string, id: string) {
  const file = path.join(dir, "daily", `${id}.csv`);
  if (!fs.existsSync(file)) return null;
  return parseCsv(fs.readFileSync(file, "utf8"));
}

function cell(csv: ReturnType<typeof parseCsv>, date: string, metric: string): string {
  const di = csv.header.indexOf("date");
  const mi = csv.header.indexOf(metric);
  const row = csv.rows.find((r) => r[di] === date);
  return mi >= 0 ? (row?.[mi] ?? "") : "";
}

function events(dir: string): Array<Record<string, any>> {
  const file = path.join(dir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function offline(): Promise<void> {
  const fx = JSON.parse(fs.readFileSync(path.resolve("samples/granola-documents.json"), "utf8")) as Fixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-granola-"));
  const recordDir = path.join(root, "record");
  const ctx = { from: "2026-06-01", to: "2026-06-30", credential: "test-refresh-token" };

  console.log("\nGranola — fixture → plugin → record\n");

  resetGranolaAuthCache();
  const summary = await importPlugin(granolaPlugin, { ...ctx, fetchImpl: fixtureFetch(fx) }, recordDir);

  // --- the daily table -----------------------------------------------------
  const daily = readCsv(recordDir, "granola");
  check("wrote record/daily/granola.csv", Boolean(daily));
  if (!daily) return;
  check("header is date + meetings/notes/minutes/words",
    ["meetings", "notes", "minutes", "words"].every((m) => daily.header.includes(m)),
    daily.header.join(","));

  // Both docs are dated 2026-06-12: one real meeting, one onboarding note.
  check("counts the real meeting", cell(daily, "2026-06-12", "meetings") === "1",
    `meetings=${cell(daily, "2026-06-12", "meetings")}`);
  check("counts the onboarding doc as a note, not a meeting",
    cell(daily, "2026-06-12", "notes") === "1", `notes=${cell(daily, "2026-06-12", "notes")}`);

  // THE regression: the note's calendar block spans 2026-06-12 → 06-19 (10,110 min).
  // The meeting's transcript runs 15:02:00 → 15:30:06 = 28 min, and that is the truth
  // (its calendar block only claimed 45). A week must never leak into the total.
  const minutes = Number(cell(daily, "2026-06-12", "minutes"));
  check("minutes come from the transcript, not the calendar plan", minutes === 28, `minutes=${minutes}`);
  check("the week-long placeholder block is ignored", minutes <= MAX_MEETING_MINUTES,
    `${minutes} ≤ ${MAX_MEETING_MINUTES}`);

  // --- searchable prose ----------------------------------------------------
  check("wrote record/daily/granola_texts.csv", summary.extraSources.includes("granola_texts"));
  const texts = readCsv(recordDir, "granola_texts");
  const prose = texts ? cell(texts, "2026-06-12", "text") : "";
  check("the day's notes are searchable prose", prose.length >= 20, `${prose.length} chars`);
  check("prose carries the AI summary", prose.includes("Hold the annual tier at $180"));
  check("prose carries the attendee", prose.includes("Dana Levi"));
  check("prose carries the onboarding note too", prose.includes("Welcome to Granola"));

  // --- journal events ------------------------------------------------------
  const evs = events(recordDir).filter((e) => e.source === "granola");
  check("one event per document (deleted one excluded)", evs.length === 2, `${evs.length} events`);
  const meeting = evs.find((e) => e.id === `granola:${MEETING_ID}`);
  const note = evs.find((e) => e.id === `granola:${NOTE_ID}`);
  check("event ids are the Granola document ids", Boolean(meeting && note));
  check("meeting event is tagged a meeting", meeting?.meta?.kind === "meeting");
  check("note event is tagged a note", note?.meta?.kind === "note");
  check("note event contributes no meeting minutes", note?.meta?.minutes === 0);
  check("meeting event keeps the verbatim transcript at full resolution",
    typeof meeting?.meta?.transcript === "string" && meeting.meta.transcript.includes("one eighty through Q3"));
  check("transcript labels the two sides", (meeting?.meta?.transcript ?? "").startsWith("Me:"));
  check("meeting event links its calendar entry", typeof meeting?.url === "string");

  // --- re-sync must not duplicate --------------------------------------------
  resetGranolaAuthCache();
  await importPlugin(granolaPlugin, { ...ctx, fetchImpl: fixtureFetch(fx) }, recordDir);
  check("re-sync does not duplicate events", events(recordDir).filter((e) => e.source === "granola").length === 2,
    `${events(recordDir).filter((e) => e.source === "granola").length} events`);

  // --- mutable events: a re-summarized meeting UPDATES in place ---------------
  // Granola regenerates a meeting's AI notes after it ends. A second sync whose
  // panel content changed must replace the event, not keep the first copy.
  const fx2 = JSON.parse(JSON.stringify(fx));
  fx2.panels[MEETING_ID][0].content.content[0].content[0].text = "Pricing decision — REVISED";
  resetGranolaAuthCache();
  await importPlugin(granolaPlugin, { ...ctx, fetchImpl: fixtureFetch(fx2) }, recordDir);
  const refreshed = events(recordDir).filter((e) => e.source === "granola");
  check("re-summarized meeting stays one event (replaced, not duplicated)", refreshed.length === 2);
  const updated = refreshed.find((e) => e.id === `granola:${MEETING_ID}`);
  check("the event text reflects the new summary", (updated?.text ?? "").includes("REVISED"),
    JSON.stringify((updated?.text ?? "").slice(0, 50)));
  const updatedTexts = readCsv(recordDir, "granola_texts");
  check("the searchable prose reflects the new summary too",
    (updatedTexts ? cell(updatedTexts, "2026-06-12", "text") : "").includes("REVISED"));

  // --- pure helpers --------------------------------------------------------
  const pm = panelToText(fx.panels[MEETING_ID][0].content);
  check("panelToText renders headings and bullets",
    pm.includes("### Pricing decision") && pm.includes("- Hold the annual tier"), JSON.stringify(pm.slice(0, 40)));
  check("transcriptToText collapses one side's consecutive turns",
    transcriptToText(fx.transcript[MEETING_ID]).split("\n").length === 2);

  fs.rmSync(root, { recursive: true, force: true });
}

/** One real, read-only sync — proves credential discovery and the live API shapes. */
async function live(): Promise<void> {
  const cred = resolveCredential(granolaPlugin);
  console.log("\nGranola — live desktop credential\n");
  check("found a refresh token on this machine", Boolean(discoverGranolaRefreshToken()));
  if (!cred) {
    console.log("  … Granola desktop not signed in; skipping the live sync.");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-granola-live-"));
  const recordDir = path.join(root, "record");
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  try {
    const s = await importPlugin(granolaPlugin, { from, to, credential: cred }, recordDir);
    check("live sync reached the Granola API", s.rows >= 0, `${s.daysWithData} day(s), ${s.eventsAdded} event(s)`);
    const daily = readCsv(recordDir, "granola");
    const mins = (daily?.rows ?? []).map((r) => Number(r[daily!.header.indexOf("minutes")] || 0));
    check("no day reports an impossible meeting length",
      mins.every((m) => m <= MAX_MEETING_MINUTES), `max ${Math.max(0, ...mins)} min`);
  } catch (e) {
    check(`live sync succeeded`, false, (e as Error).message);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await offline();
  if (process.argv.includes("--live")) await live();
  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log(`\n✓ Granola: meetings, notes and transcripts import through the API into the record.\n`);
}

void main();
