import fs from "fs";
import path from "path";
import { recordDir } from "../src/lib/paths";
import { mergeDailyCsv, readEventsFromRecord, rebuild } from "../src/lib/record";

const source = process.argv[2] || "browser_history_scrape";
const rDir = recordDir();
const events = readEventsFromRecord(rDir).filter((event) => event.source === source);
const byDate = new Map<string, { events: number; searches: number; visits: number; urls: Set<string> }>();

for (const event of events) {
  const row = byDate.get(event.date) ?? { events: 0, searches: 0, visits: 0, urls: new Set<string>() };
  row.events += 1;
  if (/search|searched/i.test(event.text)) row.searches += 1;
  if (/visit|visited|http/i.test(event.text)) row.visits += 1;
  if (event.url) row.urls.add(event.url);
  byDate.set(event.date, row);
}

const file = path.join(rDir, "daily", `${source}.csv`);
fs.rmSync(file, { force: true });
const table = {
  header: ["date", "events", "searches", "visits", "urls"],
  rows: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, row]) => [
    date,
    String(row.events),
    String(row.searches),
    String(row.visits),
    String(row.urls.size),
  ]),
};
const merged = mergeDailyCsv(rDir, source, table);
const rebuilt = rebuild({ recordDir: rDir });

console.log(JSON.stringify({
  source,
  events: events.length,
  days: merged.rows,
  file: merged.file,
  rebuilt,
}, null, 2));
