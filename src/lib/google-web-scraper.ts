import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { appendEvents, insertEventsIntoCache, mergeDailyCsv, parseCsv, readEventsFromRecord, rebuild } from "./record";
import { dataDir, recordDir } from "./paths";

export type GoogleScrapePreset =
  | "google_activity_all"
  | "browser_history"
  | "google_search"
  | "google_image_search"
  | "google_video_search"
  | "google_maps"
  | "youtube_history"
  | "google_assistant"
  | "google_play"
  | "google_news"
  | "google_chrome"
  | "google_shopping"
  | "google_translate"
  | "google_discover"
  | "google_gemini"
  | "google_timeline";

export interface GoogleScrapeEvent {
  date: string;
  ts: string;
  source: string;
  title: string;
  text: string;
  url?: string | null;
  meta?: Record<string, unknown>;
}

export interface GoogleScrapeResult {
  preset: GoogleScrapePreset;
  url: string;
  engine?: "chrome_session" | "playwright";
  events: number;
  added: number;
  dailyRows: number;
  eventRows: number;
  authRequired: boolean;
  profileDir: string;
  loginOnly?: boolean;
}

export interface GooglePresetDef {
  id: GoogleScrapePreset;
  /** Short UI label ("Search", "YouTube", …). */
  label: string;
  /** One-line UI description of what this preset imports. */
  detail: string;
  /** The authenticated Google page the extension scrapes. */
  url: string;
  /** events.jsonl `source` for every event this preset lands. */
  source: string;
  /** record/daily/<dailySource>.csv rollup this preset maintains. */
  dailySource: string;
  /** false → the extension reads the visible DOM instead of the My Activity RPC feed. */
  rpc: boolean;
  /** Set when Google removed the page this preset scraped. The Data tab keeps
   *  showing landed data but renders this guidance INSTEAD of a dead Import
   *  button (clicking through to a page Google redirects away is not a UI). */
  retired?: string;
}

/**
 * THE canonical list of predone Google scraping presets. Every other surface —
 * the ingest/status API routes, the Data-tab "Automated imports" card, the
 * Chrome extension (extensions/google-activity-exporter), and the source
 * bundles — derives from this list; add a preset here and it exists everywhere.
 * Keep extensions/google-activity-exporter/content.js IMPORTERS in sync (the
 * extension is plain JS and cannot import this module).
 */
export const GOOGLE_PRESETS: GooglePresetDef[] = [
  { id: "google_activity_all", label: "All Google activity", detail: "Every My Activity item across products (overlaps the per-product imports below)", url: "https://myactivity.google.com/myactivity?hl=en_GB", source: "google_activity_scrape", dailySource: "google_activity_scrape", rpc: true },
  { id: "browser_history", label: "Browser history", detail: "Pages you visited, from Web & App Activity", url: "https://myactivity.google.com/search-services/history?hl=en_GB", source: "browser_history_scrape", dailySource: "browser_history_scrape", rpc: true },
  { id: "google_search", label: "Search", detail: "Google Search queries", url: "https://myactivity.google.com/product/search?hl=en_GB", source: "google_search_scrape", dailySource: "google_search_scrape", rpc: true },
  { id: "google_image_search", label: "Image Search", detail: "Google Image Search activity", url: "https://myactivity.google.com/product/image_search?hl=en_GB", source: "google_image_search_scrape", dailySource: "google_image_search_scrape", rpc: true },
  { id: "google_video_search", label: "Video Search", detail: "Google Video Search activity", url: "https://myactivity.google.com/product/video_search?hl=en_GB", source: "google_video_search_scrape", dailySource: "google_video_search_scrape", rpc: true },
  { id: "google_maps", label: "Maps", detail: "Google Maps activity", url: "https://myactivity.google.com/product/maps?hl=en_GB", source: "google_maps_scrape", dailySource: "google_maps_scrape", rpc: true },
  { id: "youtube_history", label: "YouTube", detail: "YouTube watch & search history", url: "https://myactivity.google.com/product/youtube?hl=en_GB", source: "youtube_history_scrape", dailySource: "youtube_history_scrape", rpc: true },
  { id: "google_assistant", label: "Assistant", detail: "Google Assistant activity", url: "https://myactivity.google.com/product/assistant?hl=en_GB", source: "google_assistant_scrape", dailySource: "google_assistant_scrape", rpc: true },
  { id: "google_play", label: "Play", detail: "Google Play activity", url: "https://myactivity.google.com/product/play?hl=en_GB", source: "google_play_scrape", dailySource: "google_play_scrape", rpc: true },
  { id: "google_news", label: "News", detail: "Google News activity", url: "https://myactivity.google.com/product/news?hl=en_GB", source: "google_news_scrape", dailySource: "google_news_scrape", rpc: true },
  { id: "google_chrome", label: "Chrome", detail: "Chrome-sync browsing activity (differs from the local Chrome History file import)", url: "https://myactivity.google.com/product/chrome?hl=en_GB", source: "google_chrome_scrape", dailySource: "google_chrome_scrape", rpc: true },
  { id: "google_shopping", label: "Shopping", detail: "Google Shopping activity", url: "https://myactivity.google.com/product/shopping?hl=en_GB", source: "google_shopping_scrape", dailySource: "google_shopping_scrape", rpc: true },
  { id: "google_translate", label: "Translate", detail: "Google Translate history", url: "https://myactivity.google.com/product/translate?hl=en_GB", source: "google_translate_scrape", dailySource: "google_translate_scrape", rpc: true },
  { id: "google_discover", label: "Discover", detail: "Google Discover feed activity", url: "https://myactivity.google.com/product/discover?hl=en_GB", source: "google_discover_scrape", dailySource: "google_discover_scrape", rpc: true },
  { id: "google_gemini", label: "Gemini", detail: "Gemini Apps activity", url: "https://myactivity.google.com/product/gemini?hl=en_GB", source: "google_gemini_scrape", dailySource: "google_gemini_scrape", rpc: true },
  { id: "google_timeline", label: "Timeline", detail: "Maps location history", url: "https://timeline.google.com/maps/timeline", source: "google_timeline_scrape", dailySource: "google_timeline_scrape", rpc: false, retired: "Google moved Timeline into the Maps app on your phone — the web page now just redirects to Maps. Export it on the phone (Maps → Settings → Location → Export Timeline data) and drop the JSON into Data." },
];

const PRESETS = Object.fromEntries(GOOGLE_PRESETS.map((p) => [p.id, p])) as Record<GoogleScrapePreset, GooglePresetDef>;

export function isGooglePreset(x: unknown): x is GoogleScrapePreset {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(PRESETS, x);
}

export function googlePresetById(id: GoogleScrapePreset): GooglePresetDef {
  return PRESETS[id];
}

/** daily/<id>.csv ids owned by the extension presets (for registry/bundle ownership). */
export const GOOGLE_PRESET_DAILY_SOURCES: ReadonlySet<string> = new Set(
  GOOGLE_PRESETS.map((p) => p.dailySource),
);

function defaultProfileDir(): string {
  return path.join(dataDir(), "browser", "google-automation-profile");
}

/** Where the extension heartbeat lands (see /api/automations/google-activity-extension/ping).
 *  Lives under the gitignored data dir — derived state, never part of the record. */
export function extensionPingFile(): string {
  return path.join(dataDir(), "browser", "extension-ping.json");
}

/** Directory the app ships the unpacked extension from (also zipped for download). */
export function extensionSourceDir(): string {
  return path.join(process.cwd(), "extensions", "google-activity-exporter");
}

/** Version of the extension the app currently ships. The Data tab compares it to
 *  the version the installed extension reports in its ping heartbeat: unpacked
 *  installs never auto-update, so a mismatch is the only signal a user gets to
 *  replace the folder and reload the extension. */
export function extensionLatestVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionSourceDir(), "manifest.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "";
  } catch {
    return "";
  }
}

function chromeAppleScript(script: string, args: string[] = []): string {
  return execFileSync("osascript", ["-e", script, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
}

function openInChrome(url: string): void {
  chromeAppleScript(
    `
on run argv
  set targetUrl to item 1 of argv
  tell application id "com.google.chrome"
    activate
    if (count of windows) = 0 then make new window
    set URL of active tab of window 1 to targetUrl
  end tell
end run
`,
    [url],
  );
}

function runChromeJs(js: string): string {
  return chromeAppleScript(
    `
on run argv
  set jsCode to item 1 of argv
  tell application id "com.google.chrome"
    if (count of windows) = 0 then error "Google Chrome is not open."
    return execute active tab of window 1 javascript jsCode
  end tell
end run
`,
    [js],
  );
}

function chromeSnapshot(): { url: string; title: string; body: string; height: number; y: number; blocks: string[] } {
  const raw = runChromeJs(`
(function() {
  var selectors = "main [role=listitem], main article, main a[href], [role=listitem], article, c-wiz";
  var els = Array.prototype.slice.call(document.querySelectorAll(selectors));
  var seen = Object.create(null);
  var blocks = [];
  for (var i = 0; i < els.length; i++) {
    var text = (els[i].innerText || els[i].textContent || "").trim();
    if (text.length < 20 || text.length > 5000) continue;
    if (!/(20\\d{2}|today|yesterday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\\d{1,2}:\\d{2}|https?:\\/\\/)/i.test(text)) continue;
    if (seen[text]) continue;
    seen[text] = true;
    blocks.push(text);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    body: (document.body && document.body.innerText || "").slice(0, 2000),
    height: document.body ? document.body.scrollHeight : 0,
    y: window.scrollY || 0,
    blocks: blocks
  });
})()
`);
  return JSON.parse(raw || "{}") as { url: string; title: string; body: string; height: number; y: number; blocks: string[] };
}

function chromeScrollToBottom(): void {
  runChromeJs("window.scrollTo(0, document.body ? document.body.scrollHeight : 0); 'ok';");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleFromText(text: string): string {
  const first = text.split(/\n+/).map((s) => s.trim()).find(Boolean) ?? text;
  return first.slice(0, 180);
}

function dateFromText(text: string, fallback = new Date()): Date | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const explicit = normalized.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (explicit) return new Date(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3]));
  // US order: "Jan 5, 2024" / "Jan 5"
  const monthDay = normalized.match(/\b([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+(20\d{2})?\b/);
  if (monthDay) {
    const year = monthDay[3] ? Number(monthDay[3]) : fallback.getFullYear();
    const parsed = new Date(`${monthDay[1]} ${monthDay[2]}, ${year}`);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  // UK/EU order: "5 Jan 2024" / "5 January" — every preset page is requested with
  // hl=en_GB, so this is the order Google actually renders.
  const dayMonth = normalized.match(/\b(\d{1,2})\s+([A-Z][a-z]{2,8})\.?,?\s*(20\d{2})?\b/);
  if (dayMonth) {
    const year = dayMonth[3] ? Number(dayMonth[3]) : fallback.getFullYear();
    const parsed = new Date(`${dayMonth[2]} ${dayMonth[1]}, ${year}`);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return /\b(today|yesterday)\b/i.test(normalized) ? fallback : null;
}

export function isoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function extractGoogleEventsFromBlocks(
  blocks: string[],
  preset: GoogleScrapePreset,
  now: Date = new Date(),
): GoogleScrapeEvent[] {
  const cfg = PRESETS[preset];
  const out: GoogleScrapeEvent[] = [];
  const seen = new Set<string>();
  for (const raw of blocks) {
    const text = raw.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 8) continue;
    if (/sign in|choose an account|couldn.t sign you in/i.test(text)) continue;
    if (!/\b(20\d{2}|today|yesterday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}:\d{2})\b/i.test(text)) {
      continue;
    }
    const d = dateFromText(text, now);
    if (!d) continue;
    const date = isoLocalDate(d);
    const time = text.match(/\b(\d{1,2}):(\d{2})(?:\s?(AM|PM))?\b/i);
    // The page shows LOCAL wall-clock times, so the ts carries no Z suffix — a UTC
    // label would shift every displayed time by the viewer's UTC offset.
    let ts = `${date}T12:00:00.000`;
    if (time) {
      let h = Number(time[1]);
      const min = time[2];
      const ap = time[3]?.toUpperCase();
      if (ap === "PM" && h < 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      ts = `${date}T${String(h).padStart(2, "0")}:${min}:00.000`;
    }
    const url = text.match(/\bhttps?:\/\/[^\s)]+/i)?.[0] ?? null;
    const title = titleFromText(text);
    const key = `${cfg.source}\0${ts}\0${title}\0${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, ts, source: cfg.source, title, text, url, meta: { preset } });
  }
  return out;
}

interface DailyCountable {
  date: string;
  text: string;
  url?: string | null;
}

function dailyTable(events: DailyCountable[]): { header: string[]; rows: string[][] } {
  const byDate = new Map<string, { events: number; searches: number; visits: number; urls: Set<string> }>();
  for (const event of events) {
    const row = byDate.get(event.date) ?? { events: 0, searches: 0, visits: 0, urls: new Set<string>() };
    row.events++;
    if (/search|searched/i.test(event.text)) row.searches++;
    if (/visit|visited|http/i.test(event.text)) row.visits++;
    if (event.url) row.urls.add(event.url);
    byDate.set(event.date, row);
  }
  return {
    header: ["date", "events", "searches", "visits", "urls"],
    rows: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, row]) => [
      date,
      String(row.events),
      String(row.searches),
      String(row.visits),
      String(row.urls.size),
    ]),
  };
}

/** Add a batch's per-day counts on top of whatever earlier batches already landed
 *  in daily/<source>.csv. Only counts events appendEvents actually ADDED, so a
 *  retried batch never double-counts. */
function mergeDailyCountsAdditive(rDir: string, dailySource: string, added: DailyCountable[]): void {
  const table = dailyTable(added);
  const file = path.join(rDir, "daily", `${dailySource}.csv`);
  const existing = new Map<string, number[]>();
  if (fs.existsSync(file)) {
    try {
      const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
      if (header.join(",") === table.header.join(",")) {
        for (const row of rows) existing.set(row[0], row.slice(1).map((v) => Number(v) || 0));
      }
    } catch {
      /* unreadable rollup — this batch's counts stand alone until the final rebuild */
    }
  }
  const summed = {
    header: table.header,
    rows: table.rows.map((row) => {
      const prior = existing.get(row[0]);
      if (!prior) return row;
      return [row[0], ...row.slice(1).map((v, i) => String((Number(v) || 0) + (prior[i] ?? 0)))];
    }),
  };
  mergeDailyCsv(rDir, dailySource, summed);
}

function rebuildDailyFromRecord(rDir: string, preset: GoogleScrapePreset): void {
  const cfg = PRESETS[preset];
  const events = readEventsFromRecord(rDir)
    .filter((event) => event.source === cfg.source)
    .map((event) => ({
      date: event.date,
      ts: event.ts,
      source: event.source,
      title: event.title ?? "Google activity",
      text: event.text,
      url: event.url,
      meta: typeof event.meta === "object" && event.meta !== null ? event.meta as Record<string, unknown> : undefined,
    }));
  const file = path.join(rDir, "daily", `${cfg.dailySource}.csv`);
  fs.rmSync(file, { force: true });
  if (events.length) mergeDailyCsv(rDir, cfg.dailySource, dailyTable(events));
}

function flattenGoogleActivityValue(value: unknown, out: string[] = []): string[] {
  if (value == null) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenGoogleActivityValue(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) flattenGoogleActivityValue(item, out);
  }
  return out;
}

function eventDateFromFlat(parts: string[], fallback = new Date()): Date | null {
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) continue;
    let ms = 0;
    if (n > 1e15) ms = n / 1000; // Google activity often uses epoch microseconds.
    else if (n > 1e12) ms = n;
    else if (n > 1e9) ms = n * 1000;
    if (!ms) continue;
    const d = new Date(ms);
    const y = d.getFullYear();
    if (y >= 2005 && y <= fallback.getFullYear() + 1) return d;
  }
  for (const part of parts) {
    const d = dateFromText(part, fallback);
    if (d) return d;
  }
  return null;
}

/** Machine noise inside a raw activity item that must never become event text:
 *  continuation/tracking tokens (long unbroken base64url blobs) and
 *  protocol-relative asset URLs (product icons like //www.gstatic.com/...). */
export function isGoogleOpaqueBlob(s: string): boolean {
  if (s.startsWith("//")) return true;
  return /^[A-Za-z0-9_=-]{40,}$/.test(s);
}

export function extractGoogleActivityApiEvents(
  items: unknown[],
  preset: GoogleScrapePreset,
  now: Date = new Date(),
): GoogleScrapeEvent[] {
  const cfg = PRESETS[preset];
  const out: GoogleScrapeEvent[] = [];
  for (const item of items) {
    const flat = flattenGoogleActivityValue(item)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const d = eventDateFromFlat(flat, now);
    if (!d) continue;
    // date is the LOCAL day bucket (the journal is local-first and the server runs
    // on the user's machine); ts stays the exact UTC instant for ordering.
    const date = isoLocalDate(d);
    const ts = d.toISOString();
    const url = flat.find((s) => /^https?:\/\//i.test(s)) ?? null;
    const useful = flat.filter((s) => {
      if (s.length > 300) return false;
      if (/^\d+$/.test(s)) return false;
      if (/^https?:\/\//i.test(s)) return false;
      if (/^https?:/i.test(s)) return false;
      if (isGoogleOpaqueBlob(s)) return false;
      return true;
    });
    const title = useful[0] ?? url ?? "Google activity";
    const text = [...new Set(useful.concat(url ? [url] : []))].slice(0, 40).join("\n");
    if (!text) continue;
    // No meta.raw: the raw Google item is ~10KB of nested arrays nothing reads back
    // (title/text/url/ts above carry the signal). Storing it put events.jsonl past
    // V8's 512MB string cap within one long import.
    out.push({ date, ts, source: cfg.source, title: title.slice(0, 180), text, url, meta: { preset } });
  }
  return out;
}

export function ingestGoogleActivityApiItems(opts: {
  preset: GoogleScrapePreset;
  items: unknown[];
  final?: boolean;
  rDir?: string;
}): GoogleScrapeResult {
  const cfg = PRESETS[opts.preset];
  const rDir = opts.rDir ?? recordDir();
  // RPC presets post raw Google activity arrays whose embedded microsecond
  // timestamps are authoritative. DOM presets (Timeline) post visible text blocks —
  // as plain strings now, or as legacy [text, runTimestamp, url] triples whose run
  // timestamp says nothing about the activity, so the date is parsed from the text.
  const blocks: string[] = [];
  const structured: unknown[] = [];
  for (const item of opts.items) {
    if (typeof item === "string") blocks.push(item);
    else if (!cfg.rpc && Array.isArray(item) && typeof item[0] === "string") blocks.push(item[0]);
    else structured.push(item);
  }
  const events = [
    ...extractGoogleEventsFromBlocks(blocks, opts.preset),
    ...extractGoogleActivityApiEvents(structured, opts.preset),
  ];
  const written = appendEvents(events, { recordDir: rDir });
  // Per-batch daily rollup must ADD to what earlier batches landed — a day spans
  // several newest-first pages, so overwriting with only this batch's counts would
  // leave a paused import permanently undercounted. The final rebuild recomputes
  // exactly from the full record (fixing any cross-batch unique-URL drift).
  if (written.items.length) mergeDailyCountsAdditive(rDir, cfg.dailySource, written.items);
  if (opts.final) rebuildDailyFromRecord(rDir, opts.preset);
  // A paused/aborted import must still reach the SQLite cache (journal + graphs
  // read events from there). A full rebuild re-parses the whole events.jsonl —
  // hundreds of MB on a lifetime record — so mid-run batches insert their events
  // incrementally and only the final batch pays for the exact rebuild.
  if (!opts.final && written.items.length && !opts.rDir) insertEventsIntoCache(written.items);
  const rebuilt = opts.final ? rebuild({ recordDir: rDir }) : { daily: 0, events: 0 };
  return {
    preset: opts.preset,
    url: cfg.url,
    engine: "chrome_session",
    events: events.length,
    added: written.added,
    dailyRows: rebuilt.daily,
    eventRows: rebuilt.events,
    authRequired: false,
    profileDir: "Chrome extension",
  };
}

async function loadChromium() {
  const spec = "playwright-core";
  try {
    const mod = (await import(/* webpackIgnore: true */ spec)) as typeof import("playwright-core");
    return mod.chromium;
  } catch {
    throw new Error("Install Playwright once: npm i playwright-core && npx playwright install chromium");
  }
}

async function extractBlocksFromPage(page: import("playwright-core").Page): Promise<string[]> {
  return page.locator("main [role=listitem], main article, main a[href], [role=listitem], article").evaluateAll((els) => {
    const blocks: string[] = [];
    for (const el of els) {
      const text = (el.textContent ?? "").trim();
      if (text.length >= 20 && text.length <= 5000 && /\b(20\d{2}|today|yesterday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}:\d{2}|https?:\/\/)/i.test(text)) {
        blocks.push(text);
      }
    }
    return [...new Set(blocks)];
  });
}

async function pageNeedsGoogleAuth(page: import("playwright-core").Page): Promise<boolean> {
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return /sign in|sign into|choose an account|couldn.t sign you in|to continue to|use your google account/i.test(body);
}

export async function runGoogleWebScrape(opts: {
  preset: GoogleScrapePreset;
  engine?: "chrome_session" | "playwright";
  headed?: boolean;
  loginOnly?: boolean;
  maxScrolls?: number;
  profileDir?: string;
  rDir?: string;
}): Promise<GoogleScrapeResult> {
  const cfg = PRESETS[opts.preset];
  if ((opts.engine ?? "chrome_session") === "chrome_session") {
    if (opts.loginOnly) return runGoogleChromeSessionCheck(opts);
    return runGoogleChromeSessionScrape(opts);
  }
  const profileDir = opts.profileDir ?? defaultProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });
  const chromium = await loadChromium();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headed ? false : true,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  const blocks: string[] = [];
  try {
    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    if (opts.headed && opts.loginOnly) {
      let authRequired = await pageNeedsGoogleAuth(page);
      const deadline = Date.now() + 300000;
      while (authRequired && Date.now() < deadline) {
        await page.waitForTimeout(2000);
        authRequired = await pageNeedsGoogleAuth(page);
      }
      if (!authRequired) {
        await page.waitForTimeout(3000);
        authRequired = await pageNeedsGoogleAuth(page);
      }
      await context.close().catch(() => undefined);
      const rebuilt = rebuild({ recordDir: opts.rDir ?? recordDir() });
      return {
        preset: opts.preset,
        url: cfg.url,
        engine: "playwright",
        events: 0,
        added: 0,
        dailyRows: rebuilt.daily,
        eventRows: rebuilt.events,
        authRequired,
        profileDir,
        loginOnly: true,
      };
    }
    const maxScrolls = Math.max(1, Math.min(opts.maxScrolls ?? 30, 500));
    let stable = 0;
    let lastHeight = 0;
    for (let i = 0; i < maxScrolls; i++) {
      blocks.push(...await extractBlocksFromPage(page));
      const height = await page.evaluate(() => document.body.scrollHeight);
      if (height === lastHeight) stable++;
      else stable = 0;
      lastHeight = height;
      if (stable >= 3) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200 + Math.min(i * 50, 800));
    }
    blocks.push(...await extractBlocksFromPage(page));
  } finally {
    await context.close().catch(() => undefined);
  }

  const uniqueBlocks = [...new Set(blocks)];
  const authRequired = uniqueBlocks.some((b) => /sign in|choose an account/i.test(b)) || uniqueBlocks.length < 2;
  const events = authRequired ? [] : extractGoogleEventsFromBlocks(uniqueBlocks, opts.preset);
  const rDir = opts.rDir ?? recordDir();
  const written = appendEvents(events, { recordDir: rDir });
  if (events.length) mergeDailyCsv(rDir, cfg.dailySource, dailyTable(events));
  const rebuilt = rebuild({ recordDir: rDir });
  return {
    preset: opts.preset,
    url: cfg.url,
    engine: "playwright",
    events: events.length,
    added: written.added,
    dailyRows: rebuilt.daily,
    eventRows: rebuilt.events,
    authRequired,
    profileDir,
  };
}

export async function runGoogleChromeSessionCheck(opts: {
  preset: GoogleScrapePreset;
  rDir?: string;
}): Promise<GoogleScrapeResult> {
  const cfg = PRESETS[opts.preset];
  openInChrome(cfg.url);
  await sleep(2500);
  const snapshot = chromeSnapshot();
  const authRequired =
    /sign in|sign into|choose an account|couldn.t sign you in|to continue to|use your google account/i.test(snapshot.body || "") ||
    /accounts\.google\.com/.test(snapshot.url || "");
  const rebuilt = rebuild({ recordDir: opts.rDir ?? recordDir() });
  return {
    preset: opts.preset,
    url: cfg.url,
    engine: "chrome_session",
    events: 0,
    added: 0,
    dailyRows: rebuilt.daily,
    eventRows: rebuilt.events,
    authRequired,
    profileDir: "Google Chrome active session",
    loginOnly: true,
  };
}

export async function runGoogleChromeSessionScrape(opts: {
  preset: GoogleScrapePreset;
  maxScrolls?: number;
  rDir?: string;
}): Promise<GoogleScrapeResult> {
  const cfg = PRESETS[opts.preset];
  const rDir = opts.rDir ?? recordDir();
  openInChrome(cfg.url);
  await sleep(3000);

  const blocks: string[] = [];
  let stable = 0;
  let lastHeight = 0;
  let lastBlockCount = 0;
  const maxScrolls = Math.max(1, Math.min(opts.maxScrolls ?? 80, 2000));
  let lastSnapshot = chromeSnapshot();
  for (let i = 0; i < maxScrolls; i++) {
    lastSnapshot = chromeSnapshot();
    blocks.push(...(lastSnapshot.blocks ?? []));
    const blockCount = new Set(blocks).size;
    if (lastSnapshot.height === lastHeight && blockCount === lastBlockCount) stable++;
    else stable = 0;
    lastHeight = lastSnapshot.height;
    lastBlockCount = blockCount;
    if (stable >= 5) break;
    chromeScrollToBottom();
    await sleep(1300 + Math.min(i * 40, 1200));
  }
  lastSnapshot = chromeSnapshot();
  blocks.push(...(lastSnapshot.blocks ?? []));

  const uniqueBlocks = [...new Set(blocks)];
  const authRequired =
    /sign in|sign into|choose an account|couldn.t sign you in|to continue to|use your google account/i.test(lastSnapshot.body || "") ||
    /accounts\.google\.com/.test(lastSnapshot.url || "");
  const events = authRequired ? [] : extractGoogleEventsFromBlocks(uniqueBlocks, opts.preset);
  const written = appendEvents(events, { recordDir: rDir });
  if (events.length) mergeDailyCsv(rDir, cfg.dailySource, dailyTable(events));
  const rebuilt = rebuild({ recordDir: rDir });
  return {
    preset: opts.preset,
    url: cfg.url,
    engine: "chrome_session",
    events: events.length,
    added: written.added,
    dailyRows: rebuilt.daily,
    eventRows: rebuilt.events,
    authRequired,
    profileDir: "Google Chrome active session",
  };
}
