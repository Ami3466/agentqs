#!/usr/bin/env tsx
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { readConfig, writeConfig } from "../src/lib/config";
import { dbPath, recordDir } from "../src/lib/paths";
import { appendEvents, mergeDailyCsv, parseCsv, rebuild } from "../src/lib/record";

const SOURCE = "notion_journal";
const TEXT_SOURCE = "notion_journal_texts";
const PAGE_PREFIX = "notion-page:";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function cleanHeader(s: string): string {
  return s.replace(/^\uFEFF/, "").trim();
}

function metricName(raw: string): string {
  const h = cleanHeader(raw);
  const known: Record<string, string> = {
    "When did I go to sleep?": "sleep_time",
    "When did I wake up?": "wake_time",
    "Quality Of Sleep": "sleep_quality",
    Happines: "happiness",
    "Studying": "studying",
    "Studying ": "studying",
    Studing: "studying",
    "Where Do I": "location",
    "Reading/listening": "reading_listening",
    "Reading/listening ": "reading_listening",
    "Morning writing": "morning_writing",
    "Morning writing ": "morning_writing",
    "What makes me feel significant today?": "significance",
    "What makes me feel significant today? ": "significance",
    "Files & media": "files_media",
    "♥": "heart",
    Name: "title",
  };
  if (known[h]) return known[h];
  return h
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const dt = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  }
  return null;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths.map(expandHome)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function compact(values: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.join(" | ");
}

function buildNotionJournalTable(file: string): { header: string[]; rows: string[][]; days: number; rowsIn: number } {
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  const cleaned = header.map(cleanHeader);
  const dateIdx = cleaned.findIndex((h) => h.toLowerCase() === "created");
  if (dateIdx < 0) throw new Error(`No Created column in ${file}`);

  const metricIdx: Array<{ idx: number; metric: string }> = [];
  const used = new Set<string>();
  for (let i = 0; i < cleaned.length; i++) {
    if (i === dateIdx) continue;
    const metric = metricName(cleaned[i]);
    if (!metric || used.has(metric)) continue;
    used.add(metric);
    metricIdx.push({ idx: i, metric });
  }

  const byDate = new Map<string, Map<string, string[]>>();
  const entries = new Map<string, number>();
  for (const row of rows) {
    const date = parseDate(row[dateIdx] ?? "");
    if (!date) continue;
    entries.set(date, (entries.get(date) ?? 0) + 1);
    const day = byDate.get(date) ?? new Map<string, string[]>();
    for (const { idx, metric } of metricIdx) {
      const value = (row[idx] ?? "").trim();
      if (!value) continue;
      const list = day.get(metric) ?? [];
      list.push(value);
      day.set(metric, list);
    }
    byDate.set(date, day);
  }

  const outHeader = ["date", "entries", ...metricIdx.map((m) => m.metric)];
  const outRows = [...byDate.keys()].sort().map((date) => {
    const day = byDate.get(date)!;
    return [
      date,
      String(entries.get(date) ?? 0),
      ...metricIdx.map(({ metric }) => compact(day.get(metric) ?? [])),
    ];
  });
  return { header: outHeader, rows: outRows, days: outRows.length, rowsIn: rows.length };
}

function buildTextTable(file: string): { header: string[]; rows: string[][]; days: number; rowsIn: number } {
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  const cleaned = header.map(cleanHeader);
  const dateIdx = cleaned.findIndex((h) => h.toLowerCase() === "date");
  const charsIdx = cleaned.findIndex((h) => h.toLowerCase() === "chars");
  const textIdx = cleaned.findIndex((h) => h.toLowerCase() === "text");
  if (dateIdx < 0 || textIdx < 0) throw new Error(`No date/text columns in ${file}`);

  const byDate = new Map<string, { chars: number; text: string[] }>();
  for (const row of rows) {
    const date = parseDate(row[dateIdx] ?? "");
    if (!date) continue;
    const slot = byDate.get(date) ?? { chars: 0, text: [] };
    const n = Number((row[charsIdx] ?? "").trim());
    if (Number.isFinite(n)) slot.chars += n;
    const text = (row[textIdx] ?? "").trim();
    if (text) slot.text.push(text);
    byDate.set(date, slot);
  }
  const outRows = [...byDate.keys()].sort().map((date) => {
    const slot = byDate.get(date)!;
    return [date, String(slot.chars || compact(slot.text).length), compact(slot.text)];
  });
  return { header: ["date", "chars", "text"], rows: outRows, days: outRows.length, rowsIn: rows.length };
}

function titleFromMarkdown(file: string, text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("# "));
  return line ? line.replace(/^#\s+/, "").trim() : path.basename(file, path.extname(file));
}

function dateForPage(file: string, text: string): string {
  const name = path.basename(file);
  const fallback = fs.statSync(file).mtime.toISOString().slice(0, 10);
  const currentYear = new Date().getFullYear();
  let m = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Number(m[1]) <= currentYear ? `${m[1]}-${m[2]}-${m[3]}` : fallback;
  m = name.match(/(20\d{2})/);
  if (m) return Number(m[1]) <= currentYear ? `${m[1]}-01-01` : fallback;
  m = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return Number(m[1]) <= currentYear ? `${m[1]}-${m[2]}-${m[3]}` : fallback;
  return fallback;
}

function importNotionPages(dir: string, rDir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(md|csv)$/i.test(f) && f !== "2022-summarize-table.csv")
    .map((f) => path.join(dir, f))
    .sort();
  const imported = files.map((file) => {
    const text = fs.readFileSync(file, "utf8").trim();
    const id = PAGE_PREFIX + crypto.createHash("sha1").update(file).digest("hex").slice(0, 16);
    const date = dateForPage(file, text);
    const title = titleFromMarkdown(file, text);
    return {
      id,
      date,
      ts: `${date}T12:00:00.000Z`,
      source: "notion_page",
      title,
      text,
      meta: { file },
    };
  });

  return appendEvents(imported, { recordDir: rDir }).added;
}

async function main(): Promise<void> {
  const journalFile = firstExisting([
    "~/Downloads/ExportBlock-bb4469ae-52f3-4b23-a0ad-c966b8543394-Part-1/Journal 0da17dc78a154f45afab4b0ec454cd8c_all.csv",
    "~/Desktop/example-journal/data/notion-pages/2022-summarize-table.csv",
    "~/Library/CloudStorage/GoogleDrive-amit@flowengine.cloud/My Drive/Journal Notion.csv",
  ]);
  const textFile = firstExisting([
    "~/Desktop/example-journal/data/journal/journal_texts.csv",
    "~/Desktop/agentqs-example-data/record/daily/journal_texts.csv",
  ]);
  if (!journalFile) throw new Error("No Notion journal export found");

  const rDir = recordDir();
  const journal = buildNotionJournalTable(journalFile);
  const journalMerge = mergeDailyCsv(rDir, SOURCE, journal);
  let textMerge = null;
  let text: ReturnType<typeof buildTextTable> | null = null;
  if (textFile) {
    text = buildTextTable(textFile);
    textMerge = mergeDailyCsv(rDir, TEXT_SOURCE, text);
  }
  const pages = importNotionPages(expandHome("~/Desktop/example-journal/data/notion-pages"), rDir);
  rebuild({ recordDir: rDir, dbPath: dbPath() });

  const cfg = readConfig();
  if (cfg) {
    const now = new Date().toISOString();
    cfg.sourceSyncedAt = { ...(cfg.sourceSyncedAt ?? {}), [SOURCE]: now };
    if (textFile) cfg.sourceSyncedAt[TEXT_SOURCE] = now;
    writeConfig(cfg);
  }

  console.log(
    JSON.stringify(
      {
        notionJournal: {
          file: journalFile,
          rowsIn: journal.rowsIn,
          days: journal.days,
          rows: journalMerge.rows,
          cells: journalMerge.cells,
        },
        notionJournalTexts: textFile && textMerge && text
          ? { file: textFile, rowsIn: text.rowsIn, days: text.days, rows: textMerge.rows, cells: textMerge.cells }
          : null,
        notionPages: pages,
      },
      null,
      2,
    ),
  );
}

void main().catch((e) => {
  console.error(`import-notion-journal: ${(e as Error).message}`);
  process.exit(1);
});
