#!/usr/bin/env tsx
/**
 * Ships-when proof for the folder-import accounting contract.
 *
 *   MAIN: importTree walks a folder and puts EVERY file in exactly one bucket —
 *   clean CSV structures into the daily record, prose lands raw in the inbox,
 *   known formats route to their importer commands, junk is ignored, and
 *   residue (files nothing claims) is returned AND persisted as a pending
 *   inbox notification. Re-importing the same folder adds nothing twice.
 *
 * Drives production code against a temp AGENTQS_DATA_DIR — no network.
 * Run: npm run tree:test
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-tree-"));
process.env.AGENTQS_DATA_DIR = dataDir;

import { importTree } from "../src/lib/import-tree";
import { importRaw, structure } from "../src/lib/cli-core";
import { appendInboxItem, readInboxFromRecord } from "../src/lib/record";
import { structureCsv } from "../src/lib/structure";
import { recordDir } from "../src/lib/paths";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// ---- build a messy folder ---------------------------------------------------
const tree = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-drop-"));
fs.writeFileSync(path.join(tree, "sleep.csv"), "date,sleep_min\n2026-07-01,420\n2026-07-02,455\n");
fs.writeFileSync(path.join(tree, "notes.md"), "# Trip notes\nOn 2026-07-02 we hiked 14km.\n");
fs.writeFileSync(path.join(tree, ".DS_Store"), "junk");
fs.writeFileSync(path.join(tree, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 254, 0, 7]));
fs.mkdirSync(path.join(tree, "sub"));
fs.writeFileSync(path.join(tree, "sub", "empty.txt"), "");
fs.writeFileSync(path.join(tree, "sub", "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
// Apple Health / Safari routing fixtures: a REAL Health export.xml (bare +
// zipped), the CDA companion, an imposter zip whose export.xml is NOT Health
// data, and a Safari History.db (sqlite magic + its table names).
const healthXmlBody = `<?xml version="1.0"?>\n<!DOCTYPE HealthData []>\n<HealthData locale="en_US">\n</HealthData>\n`;
fs.writeFileSync(path.join(tree, "export.xml"), healthXmlBody);
fs.writeFileSync(path.join(tree, "export_cda.xml"), `<?xml version="1.0"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3">\n</ClinicalDocument>\n`);
const safariDb = Buffer.alloc(4096);
safariDb.write("SQLite format 3\0", 0, "latin1");
fs.writeFileSync(path.join(tree, "History.db"), safariDb);
let zipOk = false;
try {
  fs.mkdirSync(path.join(tree, "zipsrc", "Takeout"), { recursive: true });
  fs.writeFileSync(path.join(tree, "zipsrc", "Takeout", "x.txt"), "hello");
  execFileSync("zip", ["-q", "-r", path.join(tree, "takeout.zip"), "Takeout"], { cwd: path.join(tree, "zipsrc") });
  fs.mkdirSync(path.join(tree, "zipsrc", "apple_health_export"), { recursive: true });
  fs.writeFileSync(path.join(tree, "zipsrc", "apple_health_export", "export.xml"), healthXmlBody);
  execFileSync("zip", ["-q", "-r", path.join(tree, "health.zip"), "apple_health_export"], { cwd: path.join(tree, "zipsrc") });
  fs.rmSync(path.join(tree, "zipsrc", "apple_health_export"), { recursive: true });
  // Imposter: some other product's export.xml inside a zip — must NOT claim Health.
  fs.mkdirSync(path.join(tree, "zipsrc", "vendor"), { recursive: true });
  fs.writeFileSync(path.join(tree, "zipsrc", "vendor", "export.xml"), `<?xml version="1.0"?>\n<catalog><item/></catalog>\n`);
  execFileSync("zip", ["-q", "-r", path.join(tree, "vendor.zip"), "vendor"], { cwd: path.join(tree, "zipsrc") });
  fs.rmSync(path.join(tree, "zipsrc"), { recursive: true });
  zipOk = true;
} catch {
  console.log("  (zip unavailable — archive case skipped)");
}

// ---- 1. every file lands in exactly one bucket -------------------------------
console.log("\nimportTree accounting");
const r1 = importTree(tree);
const byPath = new Map(r1.outcomes.map((o) => [o.path, o]));
check("csv structured", byPath.get("sleep.csv")?.bucket === "structured", byPath.get("sleep.csv")?.detail);
check("cells merged", r1.cells === 2, `cells=${r1.cells}`);
check("csv in the daily record", fs.readFileSync(path.join(recordDir(), "daily", "sleep.csv"), "utf8").includes("2026-07-02,455"));
check("prose landed in inbox", byPath.get("notes.md")?.bucket === "inbox");
check("system file ignored", byPath.get(".DS_Store")?.bucket === "ignored");
check("empty file ignored", byPath.get(path.join("sub", "empty.txt"))?.bucket === "ignored");
check("binary is residue", byPath.get("blob.bin")?.bucket === "residue", byPath.get("blob.bin")?.detail);
check("photo routed to photos importer", byPath.get(path.join("sub", "photo.jpg"))?.bucket === "importer");
if (zipOk) check("takeout zip routed to its importer", byPath.get("takeout.zip")?.bucket === "importer", byPath.get("takeout.zip")?.detail);
check(
  "bare Health export.xml routed to health_daily",
  byPath.get("export.xml")?.bucket === "importer" && !!byPath.get("export.xml")?.detail.includes("health_daily"),
  byPath.get("export.xml")?.detail,
);
check("export_cda.xml (CDA companion) ignored, not residue", byPath.get("export_cda.xml")?.bucket === "ignored", byPath.get("export_cda.xml")?.detail);
check(
  "History.db routed to the safari importer",
  byPath.get("History.db")?.bucket === "importer" && !!byPath.get("History.db")?.detail.includes("safari"),
  byPath.get("History.db")?.detail,
);
if (zipOk) {
  check(
    "Health export.zip routed to health_daily (member sniffed)",
    byPath.get("health.zip")?.bucket === "importer" && !!byPath.get("health.zip")?.detail.includes("health_daily"),
    byPath.get("health.zip")?.detail,
  );
  check(
    "imposter zip with a non-Health export.xml is residue, not claimed",
    byPath.get("vendor.zip")?.bucket === "residue",
    `${byPath.get("vendor.zip")?.bucket}: ${byPath.get("vendor.zip")?.detail}`,
  );
}
const bucketSum = Object.values(r1.buckets).reduce((a, b) => a + b, 0);
check("buckets sum to files (nothing silent)", bucketSum === r1.files, `${bucketSum}/${r1.files}`);

// ---- 2. the receipt is persisted, pending, and names the residue -------------
console.log("\npersisted receipt");
const inbox1 = readInboxFromRecord(recordDir());
const receipt = inbox1.find((i) => i.id === r1.notificationId);
check("notification exists", !!receipt);
check("pending (residue demands action)", receipt?.status === "pending", receipt?.status);
check("residue named in the text", !!receipt?.text.includes("blob.bin"));

// ---- 3. idempotent: re-import adds nothing ------------------------------------
console.log("\nre-import is a no-op");
const r2 = importTree(tree);
check("csv now unchanged/ignored", r2.buckets.structured === 0 && r2.cells === 0, JSON.stringify(r2.buckets));
check("one receipt per folder (same id)", r2.notificationId === r1.notificationId);
const inbox2 = readInboxFromRecord(recordDir());
check("no duplicate inbox items", inbox2.length === inbox1.length, `${inbox1.length} → ${inbox2.length}`);
const receipt2 = inbox2.find((i) => i.id === r2.notificationId);
check("receipt reflects the LATEST run", !!receipt2?.text.includes("0 structured"), receipt2?.text.split("\n")[1]);

// ---- 4. clean folder → reference receipt, no residue --------------------------
console.log("\nclean folder");
const clean = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-clean-"));
fs.writeFileSync(path.join(clean, "hr.csv"), "date,hr\n2026-07-03,61\n");
const r3 = importTree(clean);
check("no residue", r3.residue.length === 0);
const receipt3 = readInboxFromRecord(recordDir()).find((i) => i.id === r3.notificationId);
check("clean receipt is reference, not pending", receipt3?.status === "reference", receipt3?.status);

// ---- 5. a lossy CSV never lands silently — on ANY channel ---------------------
console.log("\nCSV loss accounting (shared by every channel)");
const lossyCsv = "date,steps,\n2026-07-01,100,extra\nBAD-DATE,200,\n\n2026-07-02,300,\n";
const s = structureCsv(lossyCsv)!;
check("skipped row counted", s.skippedRows === 1, `skipped=${s.skippedRows}`);
check("sample names the bad date", s.skippedSamples[0] === "BAD-DATE", JSON.stringify(s.skippedSamples));
check("data under an empty header counted", s.droppedColumns === 1, `dropped=${s.droppedColumns}`);
check("blank spacer line is NOT a loss", s.rows.length === 2);

const lossyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-lossy-"));
fs.writeFileSync(path.join(lossyDir, "steps.csv"), lossyCsv);
const r5 = importTree(lossyDir);
check("file still structures (good rows merged)", r5.buckets.structured === 1, JSON.stringify(r5.buckets));
check("outcome names the dropped rows", !!r5.outcomes.find((o) => o.path === "steps.csv")?.detail.includes("DROPPED"));
const lossNote = readInboxFromRecord(recordDir()).find((i) => i.id.startsWith("csvloss-"));
check("loss persisted as a pending notification", lossNote?.status === "pending", lossNote?.status);
check("notification names the loss", !!lossNote?.text.includes("BAD-DATE"), lossNote?.text.split("\n")[0]);

async function asyncChecks(): Promise<void> {
  // importRaw (CLI single file / MCP import_file / API): binary refused loudly.
  console.log("\nimportRaw refuses what can't land");
  const blob = path.join(lossyDir, "garbage.dat");
  fs.writeFileSync(blob, Buffer.from([0, 1, 2, 0, 255, 254, 0, 7]));
  let rawErr = "";
  try {
    await importRaw({ file: blob });
  } catch (e) {
    rawErr = e instanceof Error ? e.message : String(e);
  }
  check("binary throws, nothing landed", rawErr.includes("Binary file"), rawErr);

  // Agent CSV (structure --csv / MCP structure): lossy CSV rejected ATOMICALLY.
  console.log("\nagent CSV is all-or-nothing");
  const memo = appendInboxItem({ text: "walked a lot around town" }, { recordDir: recordDir() });
  const strict = await structure({ id: memo.id, csv: "date,steps\n2026-07-01,900\nJuly somethingth,100\n" });
  const strictRes = strict.results.find((x: { id: string }) => x.id === memo.id);
  check("rejected with error", strictRes?.status === "error", strictRes?.message);
  check("nothing merged for the item", !fs.existsSync(path.join(recordDir(), "daily", "notes.csv")));
  const ok = await structure({ id: memo.id, csv: "date,steps\n2026-07-01,900\n2026-07-02,100\n" });
  check("fixed CSV then structures", ok.results.find((x: { id: string }) => x.id === memo.id)?.status === "structured");
}

void asyncChecks()
  .catch((e) => {
    console.error("async checks threw:", e);
    failures++;
  })
  .finally(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(clean, { recursive: true, force: true });
    fs.rmSync(lossyDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
    process.exit(failures ? 1 : 0);
  });
