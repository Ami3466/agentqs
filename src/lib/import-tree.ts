import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { recordDir } from "./paths";
import {
  appendInboxItems,
  landDailySources,
  landInboxStream,
  mergeDailyCsv,
  readInboxFromRecord,
  updateInboxItems,
} from "./record";
import { structureCsv, sourceName } from "./structure";
import { notifyCsvLoss } from "./structure-run";
import { columnGuard, splitColumnKey } from "./column-scan";
import { wipeDemoOnImport } from "./demo";
import { isStreamingHistoryFile } from "./importers/files/spotify-export";

/**
 * Folder import with a FULL ACCOUNTING: every file under the root ends in
 * exactly one bucket, and the report is persisted as an inbox notification so
 * "did everything index?" survives the console. Residue — files nothing
 * claimed — is the loud failure: the CLI exits 1 on it.
 *
 * Idempotent by design: a file's inbox id is a hash of its relative path +
 * content, so re-importing the same folder never duplicates items, and items
 * already structured/kept/discarded keep their status. Re-running after fixing
 * residue converges to a clean report.
 */

export type TreeBucket =
  | "structured" // clean CSV/TSV → merged into record/daily/<source>.csv
  | "inbox" // text landed raw, pending the structuring agent
  | "importer" // a dedicated importer claims it — `detail` is the exact command
  | "ignored" // system files, empty files, symlinks
  | "residue"; // NOTHING claimed it — the part that would otherwise be silent

export interface TreeFileOutcome {
  path: string; // relative to the root
  bucket: TreeBucket;
  detail: string; // source name, importer command, or the reason
  bytes: number;
}

export interface ImportTreeReport {
  root: string;
  files: number;
  bytes: number;
  buckets: Record<TreeBucket, number>;
  cells: number; // daily cells merged from structured CSVs
  outcomes: TreeFileOutcome[];
  residue: TreeFileOutcome[];
  /** The receipt text as persisted — faces print THIS so console and inbox
   *  never tell different stories about the same run. */
  summary: string;
  notificationId: string;
  dailyRows: number;
  pending: number;
}

const IGNORE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".localized"]);
const SKIP_DIRS = new Set([".git", ".Trash", "node_modules", "__MACOSX"]);
const TEXT_EXT = new Set([
  "csv", "tsv", "txt", "md", "markdown", "json", "jsonl", "ndjson",
  "log", "yml", "yaml", "xml", "html", "htm", "ics", "vcf",
]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tiff", "tif"]);
/** Land raw only up to this size — a bigger text file needs a real importer,
 *  not a megabyte memo nobody can structure. */
export const MAX_INBOX_BYTES = 25 * 1024 * 1024;
/** Clean CSV never lands raw, so it may be far bigger — but reading a text
 *  file into memory to try still needs SOME ceiling. */
export const MAX_STRUCTURE_BYTES = 200 * 1024 * 1024;
const RESIDUE_LIST_CAP = 40;

function ext(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export function sniffHead(file: string, bytes = 8192): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const size = Math.min(fs.fstatSync(fd).size, bytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

export function looksText(head: Buffer): boolean {
  if (head.length === 0) return false;
  let printable = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || b >= 32) printable++;
  }
  return printable / head.length > 0.95;
}

function isSqlite(head: Buffer): boolean {
  return head.length >= 16 && head.toString("latin1", 0, 15) === "SQLite format 3";
}

function isZip(head: Buffer): boolean {
  // Full magic (local header / empty / spanned) — a text file starting with
  // "PK" (e.g. a "PKG_ID,…" CSV header) must not route to the archive branch.
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2]);
}

/** Single-quote a path for the receipt's copy-paste commands — an embedded
 *  apostrophe must not terminate the quoting an agent will run verbatim. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Cheap central-directory listing; unreadable archives report as residue. */
function zipMembers(file: string): string[] | null {
  try {
    return execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** First bytes of one zip member ("" when unreadable). unzip's member arg is a
 *  GLOB, so metacharacters are escaped; `head` caps the pipe so a multi-GB
 *  member never buffers. */
function zipMemberHead(file: string, member: string, bytes = 4096): string {
  const glob = member.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
  try {
    return execFileSync("sh", ["-c", `unzip -p ${shq(file)} ${shq(glob)} | head -c ${bytes}`], {
      encoding: "utf8",
      maxBuffer: bytes * 2,
    });
  } catch {
    return "";
  }
}

function stableId(rel: string, content: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(rel)
    .update("\0")
    .update(content)
    .digest("hex")
    .slice(0, 24);
}

function walk(root: string, dir: string, out: TreeFileOutcome[], files: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isSymbolicLink()) {
      out.push({ path: rel, bucket: "ignored", detail: "symlink (not followed)", bytes: 0 });
      continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) {
        out.push({ path: rel, bucket: "ignored", detail: "skipped directory", bytes: 0 });
      } else {
        walk(root, abs, out, files);
      }
      continue;
    }
    if (e.isFile()) {
      files.push(abs);
    } else if (!e.isDirectory()) {
      // FIFOs, sockets, devices — no bucket may be silent, even this one.
      out.push({ path: rel, bucket: "ignored", detail: "special file (not a regular file)", bytes: 0 });
    }
  }
}

export function importTree(root: string): ImportTreeReport {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  wipeDemoOnImport();
  const rDir = recordDir();
  const known = new Set(readInboxFromRecord(rDir).map((i) => i.id));

  const outcomes: TreeFileOutcome[] = [];
  const files: string[] = [];
  walk(abs, abs, outcomes, files);

  // Landed items flush in bounded batches — a 20GB folder must never hold
  // every file's text in memory at once. Appended with their FINAL status and
  // meta in one write (AppendInboxInput carries both), so there is no second
  // whole-file patch pass.
  let inboxBatch: Array<{ id: string; text: string; source: string; kind: string; status?: string; meta: unknown }> = [];
  let batchBytes = 0;
  const FLUSH_BYTES = 32 * 1024 * 1024;
  const flush = () => {
    if (inboxBatch.length) appendInboxItems(inboxBatch, { recordDir: rDir });
    inboxBatch = [];
    batchBytes = 0;
  };
  const land = (item: (typeof inboxBatch)[number], bytes: number) => {
    inboxBatch.push(item);
    batchBytes += bytes;
    if (batchBytes >= FLUSH_BYTES) flush();
  };

  let cells = 0;
  // Daily stems this walk merged into — the cache patch at the end needs exactly
  // these, and nothing else in the record has to be re-read.
  const mergedSources = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    const rel = path.relative(abs, file);
    const name = path.basename(file);
    const push = (bucket: TreeBucket, detail: string, bytes: number) =>
      outcomes.push({ path: rel, bucket, detail, bytes });

    // One broken file must never abort the walk mid-way — cells already merged
    // would be left with no receipt and no undo trail. Contain it as residue.
    try {
      const bytes = fs.statSync(file).size;
      totalBytes += bytes;

      if (IGNORE_NAMES.has(name)) {
        push("ignored", "system file", bytes);
        continue;
      }
      if (bytes === 0) {
        push("ignored", "empty file", bytes);
        continue;
      }

      const head = sniffHead(file);
      if (isZip(head)) {
        const members = zipMembers(file);
        if (members === null) {
          push("residue", "unreadable archive", bytes);
        } else if (members.some((m) => m.startsWith("Takeout/"))) {
          push("importer", `npx tsx scripts/import-google-takeout-archive.ts --zip ${shq(file)}`, bytes);
        } else if (
          members.some(
            (m) =>
              // export.xml is a generic name — claim the zip for Apple Health
              // only when the member really is a HealthData document, or a
              // false claim would exit 0 and the file would never land.
              /(^|\/)export\.xml$/i.test(m) && zipMemberHead(file, m).includes("HealthData"),
          )
        ) {
          push("importer", `agentqs source file health_daily --path ${shq(file)}`, bytes);
        } else if (members.some((m) => isStreamingHistoryFile(m))) {
          // Spotify's account export — the only place a listening history exists.
          push("importer", `agentqs source file spotify --path ${shq(file)}`, bytes);
        } else {
          push("residue", "archive — unpack it or add an importer", bytes);
        }
        continue;
      }
      if (isSqlite(head)) {
        if (name === "History") push("importer", `agentqs source file chrome --path ${shq(file)}`, bytes);
        else if (name === "History.db") push("importer", `agentqs source file safari --path ${shq(file)}`, bytes);
        else if (name === "Manifest.db") push("importer", `agentqs source file iphone --path ${shq(path.dirname(file))}`, bytes);
        else push("residue", "sqlite database — no importer claims it", bytes);
        continue;
      }
      if (IMAGE_EXT.has(ext(name))) {
        push("importer", `agentqs photos import ${shq(path.dirname(file))}`, bytes);
        continue;
      }

      // A bare Apple Health export.xml is a lifetime dataset, not a memo.
      if (/^export\.xml$/i.test(name) && head.toString("utf8").includes("HealthData")) {
        push("importer", `agentqs source file health_daily --path ${shq(file)}`, bytes);
        continue;
      }
      // An unzipped Streaming_History_*.json is years of listening, not a memo —
      // and it is routinely bigger than MAX_INBOX_BYTES, so left unclaimed it would
      // land as residue: the one file that holds the history, thrown away.
      if (isStreamingHistoryFile(name)) {
        push("importer", `agentqs source file spotify --path ${shq(path.dirname(file))}`, bytes);
        continue;
      }
      // Its export_cda.xml sibling is the clinical CDA rendering (starts
      // <ClinicalDocument, usually >25MB) — no importer parses it, and the
      // metrics all live in export.xml. Ignore it rather than fail Apple's own
      // export folder as residue.
      if (/^export_cda\.xml$/i.test(name) && head.toString("utf8").includes("ClinicalDocument")) {
        push("ignored", "Apple Health CDA companion (metrics live in export.xml)", bytes);
        continue;
      }

      // A known text extension still must pass the NUL check — a UTF-16 CSV
      // read as utf8 would land NUL-riddled mojibake in the record.
      const textish = TEXT_EXT.has(ext(name)) ? !head.includes(0) : looksText(head);
      if (!textish) {
        push("residue", "binary — no importer claims it", bytes);
        continue;
      }
      // Oversized text can still be a clean CSV (which structures without
      // landing raw); only refuse what would become an unstructurable megamemo.
      const oversized = bytes > MAX_INBOX_BYTES;
      if (bytes > MAX_STRUCTURE_BYTES) {
        push("residue", "text too large — needs a dedicated importer", bytes);
        continue;
      }

      const text = fs.readFileSync(file, "utf8");
      if (!text.trim()) {
        push("ignored", "empty file", bytes);
        continue;
      }
      const id = stableId(rel, text);
      if (known.has(id)) {
        push("ignored", "unchanged — already imported", bytes);
        continue;
      }
      known.add(id);

      const table = structureCsv(text);
      // A PER-EVENT file (three expenses on Tuesday) is not daily data yet. The daily
      // table holds one row per date and `mergeDailyCsv` is keyed by date, so merging
      // it kept only the LAST row of each day and threw the rest away — while the
      // receipt reported every cell as structured. It goes to the inbox to be rolled
      // up (sum? count? average? only the reader knows), which is exactly what the
      // inbox is for. Oversized ones can't be landed raw, so they are named as residue
      // rather than flattened in silence.
      if (table && table.duplicateDates > 0) {
        if (oversized) {
          push("residue", `${table.duplicateDates} row(s) share a date — per-event data, too large to land raw`, bytes);
        } else {
          land({ id, text, source: "drop", kind: "file", meta: { filename: name, duplicateDates: table.duplicateDates } }, bytes);
          push(
            "inbox",
            `${table.duplicateDates} of ${table.rows.length} row(s) share a date — per-event data; landed raw to be rolled up, NOT flattened`,
            bytes,
          );
        }
      } else if (table) {
        // Full basename — slugSource strips the extension itself; pre-stripping
        // here would name the same file differently than importRaw does.
        const source = sourceName(name, "import");
        const merge = mergeDailyCsv(rDir, source, { header: table.header, rows: table.rows });
        notifyCsvLoss(rDir, rel, table);
        cells += merge.cells;
        mergedSources.add(source);
        // Same drop-item shape as importRaw's CSV path, so the Log's Reject
        // reverts this file's cells exactly like a GUI-structured drop.
        land({
          id,
          text: oversized ? `[${name}: ${bytes.toLocaleString()} bytes of clean CSV — merged, body not kept raw]` : text,
          source: "drop",
          kind: "file",
          status: "structured",
          meta: {
            filename: name, via: "csv", source, cells: merge.cells,
            metrics: merge.metrics, structuredAt: new Date().toISOString(), applied: merge.applied,
          },
        }, oversized ? 0 : bytes);
        push(
          "structured",
          `daily/${source}.csv · ${merge.cells} cells${table.skippedRows ? ` · ${table.skippedRows} row(s) DROPPED (loss notification queued)` : ""}`,
          bytes,
        );
      } else if (oversized) {
        push("residue", "text too large to land raw — needs a dedicated importer", bytes);
      } else {
        land({ id, text, source: "drop", kind: "file", meta: { filename: name } }, bytes);
        push("inbox", "landed raw — structure or keep it", bytes);
      }
    } catch (e) {
      push("residue", `unreadable — ${e instanceof Error ? e.message : String(e)}`, 0);
    }
  }

  flush();

  const buckets: Record<TreeBucket, number> = { structured: 0, inbox: 0, importer: 0, ignored: 0, residue: 0 };
  for (const o of outcomes) buckets[o.bucket]++;
  const residue = outcomes.filter((o) => o.bucket === "residue");

  // The receipt: ONE per folder (stable id from the root), always reflecting
  // the LATEST run — pending when residue demands action, reference when clean.
  // Searchable either way, and it survives the console.
  const notificationId = `treeimport-${crypto.createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
  const lines = [
    `Folder import: ${abs}`,
    `${outcomes.length} files — ${buckets.structured} structured (${cells} cells), ${buckets.inbox} landed in the inbox, ` +
      `${buckets.importer} routed to importers, ${buckets.ignored} ignored, ${buckets.residue} RESIDUE.`,
  ];
  const importerCmds = [...new Set(outcomes.filter((o) => o.bucket === "importer").map((o) => o.detail))];
  if (importerCmds.length) lines.push("", "Run next:", ...importerCmds.map((c) => `  ${c}`));
  if (residue.length) {
    lines.push("", "NOT indexed (add an importer or remove):");
    for (const r of residue.slice(0, RESIDUE_LIST_CAP)) lines.push(`  ${r.path} — ${r.detail}`);
    if (residue.length > RESIDUE_LIST_CAP) lines.push(`  … and ${residue.length - RESIDUE_LIST_CAP} more`);
  }
  const receipt = {
    text: lines.join("\n"),
    status: residue.length ? "pending" : "reference",
    meta: { kind: "import-report", root: abs, files: outcomes.length, bytes: totalBytes, buckets, residue: residue.slice(0, RESIDUE_LIST_CAP) },
  };
  const patched = updateInboxItems([{ id: notificationId, ...receipt }], { recordDir: rDir });
  if (!patched) {
    appendInboxItems(
      [{ id: notificationId, source: "import", kind: "notification", ...receipt }],
      { recordDir: rDir },
    );
  }

  const guard = columnGuard(rDir);
  // Only what the walk landed (plus both sides of any merge rule it re-applied) —
  // a folder import must not re-derive every event in the record to file its rows.
  const touched = [
    ...new Set([
      ...mergedSources,
      ...guard.autoMerged.flatMap((o) => [splitColumnKey(o.from).source, splitColumnKey(o.into).source]),
    ]),
  ].filter(Boolean);
  const dailyRows = landDailySources(touched, { recordDir: rDir });
  landInboxStream({ recordDir: rDir });
  const pending = readInboxFromRecord(rDir).filter((i) => i.status === "pending").length;

  return {
    root: abs,
    files: outcomes.length,
    bytes: totalBytes,
    buckets,
    cells,
    outcomes,
    residue,
    summary: receipt.text,
    notificationId,
    dailyRows,
    pending,
  };
}
