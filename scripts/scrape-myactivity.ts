import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { mergeDailyCsv, rebuild, serializeCsv } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

const START_URL = "https://myactivity.google.com/myactivity?pli=1&max=1658635199999999";
const OUT_DIR = path.join(process.cwd(), "tmp", "myactivity-scrape");

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const maxClicks = Number(arg("--max-clicks") ?? "1000");
const stopYear = Number(arg("--stop-year") ?? "2014");
const targetUrl = arg("--url") ?? START_URL;

function runAppleScript(script: string, args: string[] = []): string {
  return execFileSync("osascript", ["-", ...args], {
    input: script,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
  }).trim();
}

function execInMyActivity(js: string): string {
  const jsFile = path.join(os.tmpdir(), `agentqs-myactivity-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(jsFile, js, "utf8");
  try {
    return runAppleScript(
      `
on run argv
  set jsFile to item 1 of argv
  set jsSource to read POSIX file jsFile as «class utf8»
  tell application "Google Chrome "
    if (count of windows) = 0 then make new window
    repeat with wi from 1 to count of windows
      set w to window wi
      repeat with ti from 1 to count of tabs of w
        set t to tab ti of w
        if (URL of t as text) contains "myactivity.google.com/myactivity" then
          set active tab index of w to ti
          return execute t javascript jsSource
        end if
      end repeat
    end repeat
    tell window 1 to set t to make new tab at end of tabs with properties {URL:"${targetUrl}"}
    delay 5
    return execute t javascript jsSource
  end tell
end run
`,
      [jsFile],
    );
  } finally {
    fs.rmSync(jsFile, { force: true });
  }
}

function openTab(): void {
  runAppleScript(`
tell application "Google Chrome "
  if (count of windows) = 0 then make new window
  set found to false
  repeat with wi from 1 to count of windows
    set w to window wi
    repeat with ti from 1 to count of tabs of w
      set t to tab ti of w
      if (URL of t as text) contains "myactivity.google.com/myactivity" then
        set URL of t to "${targetUrl}"
        set active tab index of w to ti
        set found to true
        exit repeat
      end if
    end repeat
    if found then exit repeat
  end repeat
  if not found then tell window 1 to make new tab at end of tabs with properties {URL:"${targetUrl}"}
  activate
end tell
`);
}

interface ActivityEntry {
  dateHeading: string;
  date: string | null;
  time: string;
  product: string;
  action: string;
  title: string;
  text: string;
}

interface Snapshot {
  url: string;
  title: string;
  textLength: number;
  scrollY: number;
  scrollHeight: number;
  entries: ActivityEntry[];
  loadMoreVisible: boolean;
  bottomText: string;
}

const extractJs = `
(() => {
  const clean = (s) => (s || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
  const dateRe = /^(Today|Yesterday|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:,?\\s+\\d{4})?$/i;
  const all = Array.from(document.querySelectorAll("body *"));
  const heads = all
    .map((el) => ({ el, txt: clean(el.innerText || el.textContent || "") }))
    .filter((x) => x.txt === "Today" || x.txt === "Yesterday" || (x.txt.length < 40 && dateRe.test(x.txt)));

  const dateFor = (el) => {
    let out = "";
    for (const h of heads) {
      const pos = h.el.compareDocumentPosition(el);
      if (h.el === el || (pos & Node.DOCUMENT_POSITION_FOLLOWING)) out = h.txt;
    }
    return out;
  };

  const links = Array.from(document.querySelectorAll("a[aria-label^='Open details of activity']"));
  const entries = links.map((link) => {
    const aria = link.getAttribute("aria-label") || "";
    const m = aria.match(/^Open details of activity ['‘](.*)['’]$/);
    const action = m ? m[1] : clean(aria.replace(/^Open details of activity\\s*/, ""));
    let card = link;
    for (let i = 0; i < 8 && card.parentElement; i++) {
      const t = clean(card.parentElement.innerText || "");
      if (t.includes("Details") && /\\b\\d{1,2}:\\d{2}\\b/.test(t) && t.length < 1200) card = card.parentElement;
      else if (t.length > 1200) break;
      else card = card.parentElement;
    }
    const lines = (card.innerText || "").split(/\\n+/).map(clean).filter(Boolean);
    const timeLine = lines.find((line) => /\\b\\d{1,2}:\\d{2}\\b/.test(line)) || "";
    const tm = timeLine.match(/\\b(\\d{1,2}:\\d{2})\\b/);
    const detailIdx = lines.findIndex((line) => line === "Details" || line.endsWith(" Details"));
    const actionIdx = lines.findIndex((line) => line.includes(action));
    const product = lines.find((line, idx) => idx !== actionIdx && idx !== detailIdx && !/\\b\\d{1,2}:\\d{2}\\b/.test(line) && line !== "Details") || "";
    return {
      dateHeading: dateFor(link),
      date: null,
      time: tm ? tm[1] : "",
      product,
      action,
      title: action.replace(/^(Visited|Searched for|Viewed|Watched|Used|Directions to)\\s+/i, ""),
      text: lines.join("\\n"),
    };
  });

  const buttons = Array.from(document.querySelectorAll("button,[role=button]"));
  const loadMoreVisible = buttons.some((b) => clean(b.innerText || b.textContent || b.getAttribute("aria-label") || "") === "Load more");
  return JSON.stringify({
    url: location.href,
    title: document.title,
    textLength: (document.body && document.body.innerText || "").length,
    scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    entries,
    loadMoreVisible,
    bottomText: clean((document.body && document.body.innerText || "").slice(-800)),
  });
})()
`;

const loadMoreJs = `
(() => {
  const clean = (s) => (s || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
  const buttons = Array.from(document.querySelectorAll("button,[role=button]"));
  const btn = buttons.find((b) => clean(b.innerText || b.textContent || b.getAttribute("aria-label") || "") === "Load more");
  if (btn) {
    btn.scrollIntoView({ block: "center" });
    btn.click();
    return JSON.stringify({ action: "click", y: scrollY, h: document.documentElement.scrollHeight });
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  return JSON.stringify({ action: "scroll", y: scrollY, h: document.documentElement.scrollHeight });
})()
`;

function parseHeadingDate(heading: string, now = new Date()): string | null {
  const h = heading.trim();
  if (!h) return null;
  const d = new Date(now);
  if (h === "Today") return isoDate(d);
  if (h === "Yesterday") {
    d.setDate(d.getDate() - 1);
    return isoDate(d);
  }
  const cleaned = h.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+/i, "");
  const hasYear = /\b\d{4}\b/.test(cleaned);
  let parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!hasYear) {
    parsed = new Date(`${cleaned}, ${now.getFullYear()}`);
    if (parsed.getTime() > now.getTime() + 24 * 3600_000) parsed.setFullYear(parsed.getFullYear() - 1);
  }
  return isoDate(parsed);
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
openTab();
sleep(7000);

const byKey = new Map<string, ActivityEntry>();
let oldest: string | null = null;
let stagnant = 0;
let lastCount = 0;

for (let i = 0; i <= maxClicks; i++) {
  const snap = JSON.parse(execInMyActivity(extractJs)) as Snapshot;
  for (const entry of snap.entries) {
    entry.date = parseHeadingDate(entry.dateHeading);
    const key = [entry.dateHeading, entry.date, entry.time, entry.product, entry.action].join("\t");
    byKey.set(key, entry);
  }

  const dates = [...byKey.values()].map((e) => e.date).filter((d): d is string => Boolean(d)).sort();
  oldest = dates[0] ?? null;
  const newest = dates[dates.length - 1] ?? null;
  const count = byKey.size;
  console.log(
    `pass=${i} entries=${count} span=${oldest ?? "?"}..${newest ?? "?"} scroll=${snap.scrollY}/${snap.scrollHeight} loadMore=${snap.loadMoreVisible}`,
  );

  if (oldest && Number(oldest.slice(0, 4)) <= stopYear) break;
  stagnant = count === lastCount ? stagnant + 1 : 0;
  if (stagnant >= 8 && !snap.loadMoreVisible) break;
  lastCount = count;

  execInMyActivity(loadMoreJs);
  sleep(2500);
}

const entries = [...byKey.values()].sort((a, b) =>
  (a.date ?? "").localeCompare(b.date ?? "") ||
  a.time.localeCompare(b.time) ||
  a.action.localeCompare(b.action),
);

const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
fs.writeFileSync(path.join(OUT_DIR, "activity.jsonl"), jsonl, "utf8");
fs.writeFileSync(
  path.join(OUT_DIR, "activity.csv"),
  serializeCsv(["date", "time", "product", "action", "title", "date_heading"], entries.map((e) => [
    e.date ?? "",
    e.time,
    e.product,
    e.action,
    e.title,
    e.dateHeading,
  ])),
  "utf8",
);

const daily = new Map<string, { activities: number; searches: number; visits: number; maps: number; youtube: number; products: Set<string> }>();
for (const e of entries) {
  if (!e.date) continue;
  const row = daily.get(e.date) ?? { activities: 0, searches: 0, visits: 0, maps: 0, youtube: 0, products: new Set<string>() };
  row.activities++;
  if (/^Searched for/i.test(e.action) || /Search/i.test(e.product)) row.searches++;
  if (/^Visited/i.test(e.action)) row.visits++;
  if (/Maps/i.test(e.product)) row.maps++;
  if (/YouTube/i.test(e.product) || /^Watched/i.test(e.action)) row.youtube++;
  if (e.product) row.products.add(e.product);
  daily.set(e.date, row);
}

const rows = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, r]) => [
  date,
  String(r.activities),
  String(r.searches),
  String(r.visits),
  String(r.maps),
  String(r.youtube),
  String(r.products.size),
]);

const merge = mergeDailyCsv(recordDir(), "google_myactivity", {
  header: ["date", "activities", "searches", "visits", "maps", "youtube", "products"],
  rows,
});
const rebuilt = rebuild();

console.log(`wrote ${path.join(OUT_DIR, "activity.jsonl")}`);
console.log(`wrote ${path.join(OUT_DIR, "activity.csv")}`);
console.log(`merged ${merge.rows} days / ${merge.cells} cells into ${merge.file}`);
console.log(`rebuilt daily rows=${rebuilt.daily}`);
