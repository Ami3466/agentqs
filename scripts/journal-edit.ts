#!/usr/bin/env tsx
/**
 * Ships-when proof for the Journal Edit mode + Data Log reject.
 *
 *   MAIN: applyDailyEdits writes manual edits into record/daily/*.csv (set,
 *   clear, add column/row, delete column, delete row across sources), and
 *   mergeDailyCsv's `applied` change-list replayed in reverse restores the
 *   file byte-for-byte — the revert behind the Log's Reject.
 *
 * Drives the production record layer against a temp record dir — no network,
 * no app state touched. Run: npm run edit:test
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  appendInboxItem,
  applyDailyEdits,
  mergeDailyCsv,
  readInboxFromRecord,
  rebuild,
  type DailyEdit,
} from "../src/lib/record";
import { dbPath } from "../src/lib/paths";
import { inboxResolve, journalEdit, query } from "../src/lib/cli-core";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const rDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-edit-"));
const csv = (source: string) => path.join(rDir, "daily", `${source}.csv`);
const read = (source: string) => fs.readFileSync(csv(source), "utf8");

// ---- 1. merge tracks exactly what changed ----------------------------------
console.log("\nmergeDailyCsv applied-tracking");
const m1 = mergeDailyCsv(rDir, "whoop", {
  header: ["date", "recovery", "sleep"],
  rows: [
    ["2026-07-01", "60", "7.5"],
    ["2026-07-02", "72", "8.1"],
  ],
});
check("fresh merge: every cell applied with no prior value", m1.applied.length === 4 && m1.applied.every((c) => c.p === null));
const before = read("whoop");

const m2 = mergeDailyCsv(rDir, "whoop", {
  header: ["date", "recovery", "hrv"],
  rows: [
    ["2026-07-02", "80", "45"], // overwrites recovery, adds hrv
    ["2026-07-03", "65", ""], // new date
  ],
});
check(
  "overwrite merge: prior values recorded",
  m2.applied.some((c) => c.d === "2026-07-02" && c.m === "recovery" && c.p === "72"),
);
check("unchanged cells not in applied", !m2.applied.some((c) => c.m === "sleep"));

// ---- 2. reject-revert: replay applied in reverse → original bytes ----------
console.log("\nreject-revert restores the pre-merge file");
const undo: DailyEdit[] = [...m2.applied].reverse().map((c) => ({
  op: "set",
  source: "whoop",
  metric: c.m,
  date: c.d,
  value: c.p ?? "",
}));
applyDailyEdits(undo, { recordDir: rDir });
check("file is byte-identical to before the merge", read("whoop") === before);

// ---- 3. manual edits: set / clear / new column / new row -------------------
console.log("\napplyDailyEdits set + clear");
const r3 = applyDailyEdits(
  [
    { op: "set", source: "whoop", metric: "recovery", date: "2026-07-01", value: "61" },
    { op: "set", source: "whoop", metric: "mood", date: "2026-07-01", value: "good" }, // new column
    { op: "set", source: "whoop", metric: "recovery", date: "2026-07-04", value: "55" }, // new row
    { op: "set", source: "whoop", metric: "sleep", date: "2026-07-02", value: "" }, // clear
    { op: "set", source: "Manual Notes!", metric: "note", date: "2026-07-01", value: "hi" }, // slugged new source
  ],
  { recordDir: rDir },
);
check("counts", r3.sets === 4 && r3.clears === 1, JSON.stringify(r3));
const w = read("whoop");
check("cell updated", w.includes("2026-07-01,61"));
check("new column written", w.split("\n")[0] === "date,recovery,sleep,mood");
check("new row written", w.includes("2026-07-04,55"));
check("cell cleared", /2026-07-02,72,,/.test(w));
check("source name slugged", fs.existsSync(csv("manual_notes")));

// ---- 4. delete column / delete row across sources ---------------------------
console.log("\napplyDailyEdits deleteColumn + deleteRow");
const r4 = applyDailyEdits(
  [
    { op: "deleteColumn", source: "whoop", metric: "sleep" },
    { op: "deleteRow", date: "2026-07-01" }, // exists in whoop AND manual_notes
  ],
  { recordDir: rDir },
);
check("counts", r4.deletedColumns === 1 && r4.deletedRows === 1, JSON.stringify(r4));
const w4 = read("whoop");
check("column gone", !w4.split("\n")[0].includes("sleep"));
check("row gone from whoop", !w4.includes("2026-07-01"));
check("row gone from the other source too (file emptied → deleted)", !fs.existsSync(csv("manual_notes")));

// ---- 5. deleting the last column removes the file ---------------------------
console.log("\nemptied file is removed");
applyDailyEdits(
  [
    { op: "deleteColumn", source: "whoop", metric: "recovery" },
    { op: "deleteColumn", source: "whoop", metric: "hrv" },
    { op: "deleteColumn", source: "whoop", metric: "mood" },
  ],
  { recordDir: rDir },
);
check("whoop.csv deleted", !fs.existsSync(csv("whoop")));

// ---- 6. inboxResolve: keep → reference, discard → discarded, pending only ---
console.log("\ninboxResolve keep/discard");
const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-resolve-"));
process.env.AGENTQS_DATA_DIR = dataDir2;
const rDir2 = path.join(dataDir2, "record");
const keepMe = appendInboxItem({ text: "# Plans\nA living document, no dated metrics." }, { recordDir: rDir2 });
const dropMe = appendInboxItem({ text: "Name\nQ1\nQ2" }, { recordDir: rDir2 });
const kept = inboxResolve(keepMe.id, "keep");
check("keep → reference", kept.status === "reference", JSON.stringify(kept));
const dropped = inboxResolve(dropMe.id, "discard");
check("discard → discarded", dropped.status === "discarded", JSON.stringify(dropped));
check("pending queue drained", dropped.pending === 0, `pending=${dropped.pending}`);
const statuses = new Map(readInboxFromRecord(rDir2).map((i) => [i.id, i.status]));
check("statuses persisted in the record", statuses.get(keepMe.id) === "reference" && statuses.get(dropMe.id) === "discarded");
let rejected = "";
try {
  inboxResolve(keepMe.id, "keep"); // keep is pending-only
} catch (e) {
  rejected = e instanceof Error ? e.message : String(e);
}
check("keep refuses a non-pending item", rejected.includes("reference"), rejected);
const unkept = inboxResolve(keepMe.id, "discard"); // discard works on ANY status (un-keep)
check("discard un-keeps a reference memo", unkept.status === "discarded");
check("discard is idempotent", inboxResolve(keepMe.id, "discard").status === "discarded");
delete process.env.AGENTQS_DATA_DIR;
fs.rmSync(dataDir2, { recursive: true, force: true });

// ---- 7. journalEdit patches the cache (no full rebuild) and stays consistent -
console.log("\njournalEdit patches the cache to match a full rebuild");
const dataDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-jedit-"));
process.env.AGENTQS_DATA_DIR = dataDir3;
const rDir3 = path.join(dataDir3, "record");
mergeDailyCsv(rDir3, "whoop", { header: ["date", "recovery"], rows: [["2026-07-01", "60"], ["2026-07-02", "70"]] });
mergeDailyCsv(rDir3, "oura", { header: ["date", "sleep"], rows: [["2026-07-01", "7"]] });
rebuild({ recordDir: rDir3, dbPath: dbPath() });
const je = journalEdit([{ op: "set", source: "whoop", metric: "recovery", date: "2026-07-01", value: "61" }]);
check("journalEdit names the patched source", je.sources.includes("whoop"), JSON.stringify(je.sources));
const cell = query("SELECT value_num FROM daily WHERE source='whoop' AND metric='recovery' AND date='2026-07-01'");
check("the patched cache reflects the edited cell", Number(cell.rows[0]?.value_num) === 61, JSON.stringify(cell.rows));
// The patch must equal exactly what a full rebuild would produce (no cache drift).
const afterPatch = query("SELECT date,source,metric,value_num,value_text FROM daily ORDER BY source,metric,date");
rebuild({ recordDir: rDir3, dbPath: dbPath() });
const afterRebuild = query("SELECT date,source,metric,value_num,value_text FROM daily ORDER BY source,metric,date");
check("patched cache is byte-identical to a full rebuild", JSON.stringify(afterPatch.rows) === JSON.stringify(afterRebuild.rows));
delete process.env.AGENTQS_DATA_DIR;
fs.rmSync(dataDir3, { recursive: true, force: true });

fs.rmSync(rDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
