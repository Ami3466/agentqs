#!/usr/bin/env tsx
/**
 * Ships-when proof for the data-quality scanner.
 *
 *   MAIN: the same metric imported manually AND automatically (two daily columns)
 *   is detected, merged into the automatic column with full undo metadata, and a
 *   saved rule folds any manual re-import straight back — the duplicate can never
 *   split again. Rejecting the merge restores both columns AND drops the rule.
 *   PLUS: dead all-zero columns get drop findings, messy numeric values (units,
 *   separators, junk placeholders) get clean findings — both applied through the
 *   same structure-a-notification path, both revertible, and text columns are
 *   never touched.
 *
 * Drives the production core end to end — scanQuality/columnGuard/structurePending
 * against a temp data dir, plus the real `agentqs scan` / `log reject` CLIs as
 * subprocesses. No network, no LLM. Run: npm run scan:test
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { mergeDailyCsv, readInboxFromRecord } from "../src/lib/record";
import { applySavedMerges, columnGuard, pendingFindings, scanQuality, type QualityFinding } from "../src/lib/column-scan";
import { collectItems } from "../src/lib/embeddings";
import { structurePending } from "../src/lib/structure-run";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-scan-"));
process.env.AGENTQS_DATA_DIR = dataDir;
const rDir = path.join(dataDir, "record");

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/.bin/tsx");

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function runCli(args: string[]): any {
  const out = execFileSync(TSX, [path.join("bin", "agentqs-cli.ts"), ...args, "--json"], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, AGENTQS_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

const readCsv = (source: string) => {
  const file = path.join(rDir, "daily", `${source}.csv`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};
const config = () => JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));

async function main(): Promise<void> {
// Minimal setup: a config so merge rules can persist, with the auto side marked
// as a synced source (the winner-picking signal).
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({
    username: "test",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: "2026-07-01T00:00:00.000Z",
    sourceSyncedAt: { chrome_auto: "2026-07-05T00:00:00.000Z" },
  }),
);

// ---- 1. detection: manual + auto import of the same metric -----------------
console.log("\nscanQuality — manual vs auto duplicate");
mergeDailyCsv(rDir, "chrome_manual", {
  header: ["date", "visits"],
  rows: [
    ["2026-06-30", "90"],
    ["2026-07-01", "100"],
    ["2026-07-02", "220"], // conflicts with the auto value below
  ],
});
mergeDailyCsv(rDir, "chrome_auto", {
  header: ["date", "visits"],
  rows: [
    ["2026-07-02", "239"],
    ["2026-07-03", "1048"],
  ],
});

let findings = scanQuality(rDir);
check("finds exactly the duplicate pair", findings.length === 1, JSON.stringify(findings.map((f) => f.id)));
const f = findings[0];
check("it is a merge finding", f.kind === "merge");
check("auto-synced side wins", f.key === "chrome_manual.visits" && f.into === "chrome_auto.visits");
check("reason names related sources", f.reason.includes("related sources"));

// ---- 2. guard queues ONE notification, idempotently -------------------------
console.log("\ncolumnGuard — notifications");
const g1 = columnGuard(rDir);
check("queues one notification", g1.notified === 1 && g1.findings.length === 1);
const g2 = columnGuard(rDir);
check("re-scan appends nothing (stable id)", g2.notified === 0);
const note = readInboxFromRecord(rDir).find((i) => i.id === f.notificationId);
check("notification is a pending inbox item of kind notification", note?.status === "pending" && note?.kind === "notification");
const persisted = pendingFindings(rDir);
check(
  "pendingFindings rebuilds the finding from the record (persistent scanner list)",
  persisted.length === 1 &&
    persisted[0].notificationId === f.notificationId &&
    persisted[0].into === "chrome_auto.visits" &&
    persisted[0].cells === 3 &&
    persisted[0].intoAuto,
);

// ---- 3. structuring the notification applies the merge + saves the rule -----
console.log("\nstructurePending — notification = merge");
const res = await structurePending({ id: f.notificationId });
const r0 = res.results[0];
check("routes as fix and structures", r0?.route === "fix" && r0?.status === "structured");
check("moved the two auto-missing days", r0?.rowsAdded === 2);
const autoCsv = readCsv("chrome_auto") ?? "";
check("auto column has the union of dates", ["2026-06-30,90", "2026-07-01,100", "2026-07-03,1048"].every((s) => autoCsv.includes(s)));
check("conflicting day keeps the auto value", autoCsv.includes("2026-07-02,239") && !autoCsv.includes("220"));
check("manual file is gone (its only column merged away)", readCsv("chrome_manual") === null);
check("rule saved in config", config().columnMerges?.some((r: any) => r.from === "chrome_manual.visits" && r.into === "chrome_auto.visits") === true);
check("post-structure scan reports clean", res.scan != null && res.scan.findings === 0);
check("no pending findings remain after the merge", pendingFindings(rDir).length === 0);

// ---- 4. a manual re-import folds back automatically --------------------------
console.log("\napplySavedMerges — it won't happen again");
mergeDailyCsv(rDir, "chrome_manual", {
  header: ["date", "visits"],
  rows: [
    ["2026-07-02", "220"], // conflict again — auto must keep winning
    ["2026-07-04", "500"], // new day — moves over
  ],
});
const merged = applySavedMerges(rDir);
check("rule re-applied", merged.length === 1 && merged[0].moved === 1 && merged[0].kept === 1);
check("manual file folded away again", readCsv("chrome_manual") === null);
check("moved day landed in the auto column", (readCsv("chrome_auto") ?? "").includes("2026-07-04,500"));
const audit = readInboxFromRecord(rDir).filter((i) => i.kind === "notification" && i.status === "structured" && i.text.startsWith("Auto-merged"));
check("auto-merge left a structured audit item (undoable)", audit.length === 1);

// ---- 5. reject = revert the merge AND drop the rule (via the real CLI) ------
console.log("\nlog reject — undo drops the rule");
runCli(["log", "reject", f.notificationId]);
const manualCsv = readCsv("chrome_manual") ?? "";
check("manual column restored", ["2026-06-30,90", "2026-07-01,100", "2026-07-02,220"].every((s) => manualCsv.includes(s)));
const autoAfter = readCsv("chrome_auto") ?? "";
check("auto column back to its own days (+ the later fold)", autoAfter.includes("2026-07-02,239") && autoAfter.includes("2026-07-04,500") && !autoAfter.includes("2026-07-01,100"));
check("rule dropped from config", (config().columnMerges ?? []).length === 0);
findings = scanQuality(rDir);
check("pair is findable again, notification stays discarded", findings.length === 1 && columnGuard(rDir).findings[0].notificationStatus === "discarded");
// Discard drops the item from every index: FTS (rebuilt by reject) and the
// embedding collector must both stop returning it, while pending items stay.
const ftsRows = runCli(["query", `SELECT ref FROM search WHERE kind='inbox' AND ref='inbox:${f.notificationId}'`]);
check("discarded item left the FTS index", (ftsRows.rows ?? ftsRows).length === 0);
const embedRefs = collectItems(rDir).map((i) => i.ref);
check("discarded item left the embedding input", !embedRefs.includes(`inbox:${f.notificationId}`));

// ---- 6. value-duplicate detection + `agentqs scan --fix` ---------------------
console.log("\nscan --fix — value duplicates via the CLI");
mergeDailyCsv(rDir, "steps_watch", {
  header: ["date", "steps"],
  rows: [
    ["2026-07-01", "1000"],
    ["2026-07-02", "2000"],
    ["2026-07-03", "3000"],
    ["2026-07-04", "4000"],
    ["2026-07-05", "5000"],
  ],
});
mergeDailyCsv(rDir, "fitness", {
  header: ["date", "steps"],
  rows: [
    ["2026-07-01", "1000"],
    ["2026-07-02", "2001"], // within tolerance
    ["2026-07-03", "3000"],
    ["2026-07-04", "4000"],
    ["2026-07-05", "5000"],
  ],
});
const scan1 = runCli(["scan"]);
check("CLI scan flags the value duplicate", scan1.findings.some((x: any) => x.reason.includes("values match")));
const fixed = runCli(["scan", "--fix"]);
check("--fix applies the open finding", fixed.fixed.length === 1 && fixed.fixed[0].summary.includes("Merged"));
check("--fix leaves the rejected pair alone (dismissed stays dismissed)",
  runCli(["scan"]).findings.every((x: any) => x.notificationStatus !== "pending"));
check("one steps column survived", (readCsv("steps_watch") === null) !== (readCsv("fitness") === null));

// ---- 7. dead column: all values 0/blank → drop finding, fix deletes, reject restores
console.log("\ndrop — dead all-zero column");
mergeDailyCsv(rDir, "legacy_tracker", {
  header: ["date", "old_counter"],
  rows: [
    ["2026-07-01", "0"],
    ["2026-07-02", "0"],
    ["2026-07-03", "n/a"],
    ["2026-07-04", "0"],
    ["2026-07-05", "0"],
    ["2026-07-06", "0"],
  ],
});
const g3 = columnGuard(rDir);
const dead = g3.findings.find((x) => x.kind === "drop" && x.key === "legacy_tracker.old_counter");
check("dead column gets a pending drop finding", dead != null && dead.notificationStatus === "pending" && dead.cells === 6, JSON.stringify(g3.findings));
const dropRes = await structurePending({ id: dead!.notificationId });
check("structuring the drop deletes the column", dropRes.results[0]?.status === "structured" && readCsv("legacy_tracker") === null);
runCli(["log", "reject", dead!.notificationId]);
const legacyCsv = readCsv("legacy_tracker") ?? "";
check("reject restores the dead column", legacyCsv.includes("2026-07-01,0") && legacyCsv.includes("2026-07-03,n/a"));

// ---- 8. messy values: units/separators/junk in a numeric column → clean finding
console.log("\nclean — messy numeric values (via the CLI)");
mergeDailyCsv(rDir, "bodyweight", {
  header: ["date", "weight"],
  rows: [
    ["2026-07-01", "72"],
    ["2026-07-02", "73"],
    ["2026-07-03", "74"],
    ["2026-07-04", "72 kg"], // unit-wrapped → 72
    ["2026-07-05", "n/a"], // junk → cleared
    ["2026-07-06", "1,072"], // thousands separator → 1072
  ],
});
const scan2 = runCli(["scan"]);
const messy = scan2.findings.find((x: any) => x.kind === "clean" && x.key === "bodyweight.weight");
check("messy column gets a pending clean finding (3 dirty cells)", messy != null && messy.notificationStatus === "pending" && messy.cells === 3);
const fixed2 = runCli(["scan", "--fix"]);
check("--fix cleans it", fixed2.fixed.some((x: any) => x.kind === "clean" && x.summary.includes("Cleaned bodyweight.weight")));
const weightCsv = readCsv("bodyweight") ?? "";
check("values normalized, junk cleared", weightCsv.includes("2026-07-04,72") && weightCsv.includes("2026-07-06,1072") && !weightCsv.includes("kg") && !weightCsv.includes("n/a"));
runCli(["log", "reject", messy.notificationId]);
const weightBack = readCsv("bodyweight") ?? "";
check("reject restores the messy originals", weightBack.includes("72 kg") && weightBack.includes("n/a") && weightBack.includes('"1,072"'));

// ---- 9. safety: text columns and live numeric columns are never flagged ------
console.log("\nsafety — text and healthy columns stay untouched");
mergeDailyCsv(rDir, "mood_journal", {
  header: ["date", "mood_note"],
  rows: [
    ["2026-07-01", "happy"],
    ["2026-07-02", "meh"],
    ["2026-07-03", "n/a"],
    ["2026-07-04", "great"],
    ["2026-07-05", "sad"],
  ],
});
mergeDailyCsv(rDir, "cigarettes", {
  header: ["date", "smoked"],
  rows: [
    ["2026-07-01", "0"],
    ["2026-07-02", "0"],
    ["2026-07-03", "0"],
    ["2026-07-04", "2"], // one real value — an all-zero streak, not a dead column
    ["2026-07-05", "0"],
  ],
});
const safety = scanQuality(rDir).filter(
  (x: QualityFinding) => x.key.startsWith("mood_journal.") || x.key.startsWith("cigarettes."),
);
check("no findings on text or healthy columns", safety.length === 0, JSON.stringify(safety));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
}

void main();
