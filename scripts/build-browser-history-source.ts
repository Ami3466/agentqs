import fs from "fs";
import path from "path";
import { mergeDailyCsv, parseCsv, rebuild } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

const rDir = recordDir();
const dailyDir = path.join(rDir, "daily");

function readRows(source: string): { header: string[]; rows: string[][] } | null {
  const file = path.join(dailyDir, `${source}.csv`);
  if (!fs.existsSync(file)) return null;
  return parseCsv(fs.readFileSync(file, "utf8"));
}

function rowMap(table: { header: string[]; rows: string[][] } | null): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!table) return out;
  for (const row of table.rows) {
    const date = (row[0] ?? "").trim();
    if (!date) continue;
    const obj: Record<string, string> = {};
    for (let i = 1; i < table.header.length; i++) {
      const key = table.header[i];
      const value = (row[i] ?? "").trim();
      if (key && value !== "") obj[key] = value;
    }
    out.set(date, obj);
  }
  return out;
}

const myActivity = rowMap(readRows("google_myactivity"));
const chrome = rowMap(readRows("chrome"));
const dates = [...new Set([...myActivity.keys(), ...chrome.keys()])].sort();

const header = [
  "date",
  "activities",
  "searches",
  "visits",
  "viewed",
  "watched",
  "products",
  "chrome_visits",
  "chrome_pages",
  "chrome_domains",
];

const rows = dates.map((date) => {
  const a = myActivity.get(date) ?? {};
  const c = chrome.get(date) ?? {};
  return [
    date,
    a.activities ?? "",
    a.searches ?? "",
    a.visits ?? "",
    a.viewed ?? "",
    a.watched ?? "",
    a.products ?? "",
    c.visits ?? "",
    c.pages ?? "",
    c.domains ?? "",
  ];
});

const merge = mergeDailyCsv(rDir, "browser_history", { header, rows });
const rebuilt = rebuild();

console.log(`source=browser_history`);
console.log(`days=${merge.rows}`);
console.log(`cells=${merge.cells}`);
console.log(`file=${merge.file}`);
console.log(`rebuilt_daily_rows=${rebuilt.daily}`);
