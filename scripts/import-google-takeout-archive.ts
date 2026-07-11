import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { appendEvents, appendInboxItems, mergeDailyCsv, rebuild, serializeCsv } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[++i]);
  }
  return out;
}

const zips = args("--zip");
if (zips.length === 0) {
  throw new Error("Usage: npx tsx scripts/import-google-takeout-archive.ts --zip <takeout.zip> [--zip <takeout2.zip>]");
}

const outDir = path.join(process.cwd(), "tmp", "google-takeout-archive");
fs.mkdirSync(outDir, { recursive: true });

function unzipList(zip: string): string[] {
  return execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 1024 * 1024 * 200 })
    .split(/\r?\n/)
    .filter(Boolean);
}

function unzipText(zip: string, member: string): string {
  const run = (args: string[]) =>
    execFileSync("unzip", ["-p", zip, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  try {
    return run([member]);
  } catch (err) {
    // A non-ASCII member name (e.g. a Hebrew calendar) rarely survives the
    // -Z1 → -p roundtrip: zip name encodings vary by archiver and the listing
    // decode is lossy (unzip even prints `?` for bytes it can't show). Recover
    // by globbing the name's ASCII skeleton — `?`/non-ASCII runs wildcarded —
    // and excluding every other member the glob would also catch.
    const parts = member.split(/[^\x20-\x3e\x40-\x7e]+/); // non-ASCII and `?` break parts
    if (parts.length < 2) throw err;
    const list = unzipList(zip);
    // Two members garbling to the SAME listing string are indistinguishable —
    // the glob would concatenate both. Bail rather than merge two files.
    if (list.filter((m) => m === member).length > 1) throw err;
    // `*` matches zero chars, so the mirror regex must too, or a glob-matching
    // sibling escapes the exclusion list and streams in concatenated.
    const re = new RegExp(
      `^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`,
    );
    const escGlob = (s: string) => s.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
    const others = list.filter((m) => m !== member && re.test(m));
    if (others.some((m) => m.split(/[^\x20-\x3e\x40-\x7e]+/).length > 1)) throw err; // two garbled names: ambiguous
    const glob = parts.map(escGlob).join("*");
    console.warn(`recovered non-ascii member via glob: ${member}`);
    // -x args are ALSO glob patterns — escape them or a name with [ ] * ?
    // silently fails to be excluded.
    return run([glob, ...(others.length ? ["-x", ...others.map(escGlob)] : [])]);
  }
}

function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&emsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function parseDate(raw: string): Date | null {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const variants = [
    cleaned,
    cleaned.replace(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}),/, "$2 $1, $3,"),
    cleaned.replace(/ GMT([+-]\d{2}):?(\d{2})$/, " GMT$1$2"),
  ];
  for (const v of variants) {
    const d = new Date(v);
    if (Number.isFinite(d.getTime())) return d;
  }
  return null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ActivityAgg {
  activities: number;
  searches: number;
  visits: number;
  watched: number;
  viewed: number;
  products: Set<string>;
}

interface ActivityRaw {
  date: string;
  time: string;
  product: string;
  action: string;
  archive: string;
  member: string;
}

function activityAgg(): ActivityAgg {
  return { activities: 0, searches: 0, visits: 0, watched: 0, viewed: 0, products: new Set<string>() };
}

const activityDaily = new Map<string, ActivityAgg>();
const activityRaw: ActivityRaw[] = [];
let activityFiles = 0;

function importMyActivityHtml(zip: string, member: string): void {
  const productFromPath = member.split("/").slice(-2, -1)[0] ?? "Unknown";
  const html = unzipText(zip, member);
  const cards = html.split(/<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp">/g).slice(1);
  activityFiles++;
  for (const card of cards) {
    const text = stripHtml(card);
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const dateLine = [...lines].reverse().find((l) => /\b\d{4},\s+\d{1,2}:\d{2}:\d{2}\b/.test(l) || /\b[A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\b/.test(l));
    if (!dateLine) continue;
    const d = parseDate(dateLine);
    if (!d) continue;
    const product = lines[0] || productFromPath;
    const action = lines.find((l) => /^(Searched for|Visited|Watched|Viewed|Used|Listened to|Directions to|Played|Opened|Read|Purchased|Installed|Updated)\b/i.test(l)) ?? "";
    const date = isoDate(d);
    const agg = activityDaily.get(date) ?? activityAgg();
    agg.activities++;
    if (/^Searched for/i.test(action) || /Search/i.test(product)) agg.searches++;
    if (/^Visited/i.test(action)) agg.visits++;
    if (/^Watched/i.test(action)) agg.watched++;
    if (/^Viewed/i.test(action)) agg.viewed++;
    if (product) agg.products.add(product);
    activityDaily.set(date, agg);
    activityRaw.push({ date, time: d.toISOString(), product, action, archive: path.basename(zip), member });
  }
}

interface TimelineAgg {
  segments: number;
  visits: number;
  activities: number;
  distanceMeters: number;
  visitMinutes: number;
  movingMinutes: number;
  places: Set<string>;
}

function timelineAgg(): TimelineAgg {
  return { segments: 0, visits: 0, activities: 0, distanceMeters: 0, visitMinutes: 0, movingMinutes: 0, places: new Set<string>() };
}

const timelineDaily = new Map<string, TimelineAgg>();
let timelineFiles = 0;
let timelineSegments = 0;

interface FitAgg {
  steps: number;
  distanceMeters: number;
  calories: number;
  activeMinutes: number;
  heartMinutes: number;
  sleepMinutes: number;
  heartRateCount: number;
  heartRateSum: number;
  heartRateMin: number | null;
  heartRateMax: number | null;
}

function fitAgg(): FitAgg {
  return {
    steps: 0,
    distanceMeters: 0,
    calories: 0,
    activeMinutes: 0,
    heartMinutes: 0,
    sleepMinutes: 0,
    heartRateCount: 0,
    heartRateSum: 0,
    heartRateMin: null,
    heartRateMax: null,
  };
}

const fitDaily = new Map<string, FitAgg>();
let fitFiles = 0;
let fitPoints = 0;

interface CalendarAgg {
  events: number;
  timedEvents: number;
  allDayEvents: number;
  eventMinutes: number;
  calendars: Set<string>;
}

function calendarAgg(): CalendarAgg {
  return { events: 0, timedEvents: 0, allDayEvents: 0, eventMinutes: 0, calendars: new Set<string>() };
}

const calendarDaily = new Map<string, CalendarAgg>();
const calendarEventRows: Parameters<typeof appendEvents>[0] = [];
const calendarSkippedMembers: string[] = [];
let calendarFiles = 0;
let calendarEvents = 0;
let calendarSkipped = 0;

interface MapsPlacesAgg {
  savedPlaces: number;
  reviews: number;
  ratedReviews: number;
  ratingSum: number;
  countries: Set<string>;
}

function mapsPlacesAgg(): MapsPlacesAgg {
  return { savedPlaces: 0, reviews: 0, ratedReviews: 0, ratingSum: 0, countries: new Set<string>() };
}

const mapsPlacesDaily = new Map<string, MapsPlacesAgg>();
let mapsPlacesFiles = 0;
let mapsPlacesItems = 0;

function durationMinutes(start?: string, end?: string): number {
  if (!start || !end) return 0;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? (e - s) / 60000 : 0;
}

function addTimeline(date: string, update: (agg: TimelineAgg) => void): void {
  const agg = timelineDaily.get(date) ?? timelineAgg();
  update(agg);
  timelineDaily.set(date, agg);
}

function importSemanticTimeline(zip: string, member: string): void {
  const json = JSON.parse(unzipText(zip, member));
  const objects = Array.isArray(json.timelineObjects) ? json.timelineObjects : [];
  timelineFiles++;
  for (const obj of objects) {
    const visit = obj.placeVisit;
    const act = obj.activitySegment;
    const start = visit?.duration?.startTimestamp ?? act?.duration?.startTimestamp;
    const end = visit?.duration?.endTimestamp ?? act?.duration?.endTimestamp;
    if (!start) continue;
    const date = isoDate(new Date(start));
    timelineSegments++;
    addTimeline(date, (agg) => {
      agg.segments++;
      if (visit) {
        agg.visits++;
        agg.visitMinutes += durationMinutes(start, end);
        const place = visit.location?.placeId || visit.location?.name || visit.location?.address;
        if (place) agg.places.add(String(place));
      }
      if (act) {
        agg.activities++;
        agg.movingMinutes += durationMinutes(start, end);
        agg.distanceMeters += Number(act.distance ?? 0) || 0;
      }
    });
  }
}

function dateFromNanos(nanos: unknown): Date | null {
  if (nanos == null) return null;
  try {
    const ms = BigInt(String(Math.trunc(Number(nanos)))) / 1000000n;
    const d = new Date(Number(ms));
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function fitValue(point: { fitValue?: Array<{ value?: Record<string, unknown> }> }): number | null {
  const value = point.fitValue?.[0]?.value;
  if (!value) return null;
  for (const key of ["fpVal", "intVal"]) {
    const n = Number(value[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function addFit(date: string, update: (agg: FitAgg) => void): void {
  const agg = fitDaily.get(date) ?? fitAgg();
  update(agg);
  fitDaily.set(date, agg);
}

function importFitJson(zip: string, member: string): void {
  const parsed = JSON.parse(unzipText(zip, member)) as { "Data Points"?: Array<Record<string, unknown>> };
  const points = Array.isArray(parsed["Data Points"]) ? parsed["Data Points"] : [];
  if (points.length === 0) return;
  fitFiles++;
  for (const point of points) {
    const type = String(point.dataTypeName ?? "");
    const start = dateFromNanos(point.startTimeNanos);
    const end = dateFromNanos(point.endTimeNanos);
    const date = (start ?? end)?.toISOString().slice(0, 10);
    if (!date) continue;
    const value = fitValue(point as { fitValue?: Array<{ value?: Record<string, unknown> }> });
    fitPoints++;
    addFit(date, (agg) => {
      if (type === "com.google.step_count.delta" && value != null) agg.steps += value;
      if (type === "com.google.distance.delta" && value != null) agg.distanceMeters += value;
      if (type === "com.google.calories.expended" && value != null) agg.calories += value;
      if (type === "com.google.active_minutes" && value != null) agg.activeMinutes += value;
      if (type === "com.google.heart_minutes" && value != null) agg.heartMinutes += value;
      if (type === "com.google.heart_rate.bpm" && value != null) {
        agg.heartRateCount++;
        agg.heartRateSum += value;
        agg.heartRateMin = agg.heartRateMin == null ? value : Math.min(agg.heartRateMin, value);
        agg.heartRateMax = agg.heartRateMax == null ? value : Math.max(agg.heartRateMax, value);
      }
      if (type === "com.google.sleep.segment" && start && end) {
        const state = value == null ? null : Math.round(value);
        if (state !== 1 && state !== 3) agg.sleepMinutes += Math.max(0, (end.getTime() - start.getTime()) / 60000);
      }
    });
  }
}

function unfoldIcs(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseIcsDate(line: string | undefined): { date: string; at: Date | null; allDay: boolean } | null {
  if (!line) return null;
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const raw = line.slice(colon + 1).trim();
  if (/^\d{8}$/.test(raw)) {
    return { date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, at: null, allDay: true };
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const at = z
    ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)))
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(at.getTime())) return null;
  // Day attribution: a calendar event belongs to the day the user LIVED it,
  // not the UTC day. Non-Z stamps already carry the wall-clock day; Z stamps
  // are converted to this machine's timezone (a 01:00 meeting in Israel is
  // 22:00Z the day before — slicing the ISO string put it on the wrong day).
  const date = z ? localDate(at) : `${y}-${mo}-${d}`;
  return { date, at, allDay: false };
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** RFC 5545 TEXT unescape: \n → newline, \, \; \\ → literal. */
function unescapeIcsText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function importCalendarIcs(zip: string, member: string): void {
  const calendar = path.basename(member).replace(/\.ics$/i, "");
  let text = "";
  try {
    text = unzipText(zip, member);
  } catch {
    calendarSkipped++;
    calendarSkippedMembers.push(`${path.basename(zip)}: ${member}`);
    return;
  }
  const lines = unfoldIcs(text);
  calendarFiles++;
  let event: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      event = [];
      continue;
    }
    if (line === "END:VEVENT" && event) {
      const status = event.find((l) => l.startsWith("STATUS:"))?.slice("STATUS:".length).trim().toUpperCase();
      const start = parseIcsDate(event.find((l) => l.startsWith("DTSTART")));
      const end = parseIcsDate(event.find((l) => l.startsWith("DTEND")));
      const summaryLine = event.find((l) => /^SUMMARY[;:]/.test(l));
      const summary = summaryLine ? unescapeIcsText(summaryLine.slice(summaryLine.indexOf(":") + 1).trim()) : "";
      event = null;
      if (!start || status === "CANCELLED") continue;
      calendarEvents++;
      const agg = calendarDaily.get(start.date) ?? calendarAgg();
      agg.events++;
      agg.calendars.add(calendar);
      let minutes = 0;
      if (start.allDay) {
        agg.allDayEvents++;
      } else {
        agg.timedEvents++;
        if (start.at && end?.at && end.at > start.at) {
          // A multi-day event contributes at most one day to its start date —
          // a year-long event used to land as 524,220 "meeting minutes".
          minutes = Math.min((end.at.getTime() - start.at.getTime()) / 60000, 1440);
          agg.eventMinutes += minutes;
        }
      }
      calendarDaily.set(start.date, agg);
      calendarEventRows.push({
        source: "google_calendar_takeout",
        date: start.date,
        ts: start.at ? start.at.toISOString() : undefined,
        title: summary || "(untitled event)",
        text: [calendar, summary].filter(Boolean).join(" - ") || "Calendar event",
        meta: { calendar, allDay: start.allDay, ...(minutes ? { minutes: Math.round(minutes) } : {}) },
      });
      continue;
    }
    if (event) event.push(line);
  }
}

function importMapsPlacesJson(zip: string, member: string): void {
  const parsed = JSON.parse(unzipText(zip, member)) as { features?: Array<Record<string, unknown>> };
  const features = Array.isArray(parsed.features) ? parsed.features : [];
  if (features.length === 0) return;
  const isReviewFile = /\/Reviews\.json$/i.test(member);
  mapsPlacesFiles++;
  for (const feature of features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const published = props.Published ? new Date(String(props.Published)) : null;
    if (!published || !Number.isFinite(published.getTime())) continue;
    const date = published.toISOString().slice(0, 10);
    const location = (props.Location ?? {}) as Record<string, unknown>;
    const country = location["Country Code"];
    const rating = Number(props["Star Rating"]);
    const agg = mapsPlacesDaily.get(date) ?? mapsPlacesAgg();
    if (isReviewFile) {
      agg.reviews++;
      if (Number.isFinite(rating)) {
        agg.ratedReviews++;
        agg.ratingSum += rating;
      }
    } else {
      agg.savedPlaces++;
    }
    if (country) agg.countries.add(String(country));
    mapsPlacesDaily.set(date, agg);
    mapsPlacesItems++;
  }
}

for (const zip of zips) {
  const members = unzipList(zip);
  for (const member of members) {
    if (/^Takeout\/My Activity\/.+\/My ?Activity\.html$/i.test(member)) importMyActivityHtml(zip, member);
    if (/^Takeout\/Location History \(Timeline\)\/Semantic Location History\/.+\.json$/i.test(member)) importSemanticTimeline(zip, member);
    if (/^Takeout\/Fit\/All data\/derived_com\.google\..+\.json$/i.test(member)) importFitJson(zip, member);
    if (/^Takeout\/Calendar\/.+\.ics$/i.test(member)) importCalendarIcs(zip, member);
    if (/^Takeout\/Maps \(your places\)\/(Saved Places|Reviews)\.json$/i.test(member)) importMapsPlacesJson(zip, member);
  }
}

const activityRows = [...activityDaily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, a]) => [
  date,
  String(a.activities),
  String(a.searches),
  String(a.visits),
  String(a.watched),
  String(a.viewed),
  String(a.products.size),
]);

const timelineRows = [...timelineDaily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, t]) => [
  date,
  String(t.segments),
  String(t.visits),
  String(t.activities),
  String(Math.round(t.visitMinutes)),
  String(Math.round(t.movingMinutes)),
  String(Math.round(t.distanceMeters)),
  String(t.places.size),
]);

const fitRows = [...fitDaily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, f]) => [
  date,
  String(Math.round(f.steps)),
  String(Math.round(f.distanceMeters)),
  String(Math.round(f.calories)),
  String(Math.round(f.activeMinutes)),
  String(Math.round(f.heartMinutes)),
  String(Math.round(f.sleepMinutes)),
  String(f.heartRateCount),
  f.heartRateCount > 0 ? String(Math.round(f.heartRateSum / f.heartRateCount)) : "",
  f.heartRateMin == null ? "" : String(Math.round(f.heartRateMin)),
  f.heartRateMax == null ? "" : String(Math.round(f.heartRateMax)),
]);

const calendarRows = [...calendarDaily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, c]) => [
  date,
  String(c.events),
  String(c.timedEvents),
  String(c.allDayEvents),
  String(Math.round(c.eventMinutes)),
  String(c.calendars.size),
]);

const mapsPlacesRows = [...mapsPlacesDaily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, m]) => [
  date,
  String(m.savedPlaces),
  String(m.reviews),
  String(m.ratedReviews),
  m.ratedReviews > 0 ? String(Math.round((m.ratingSum / m.ratedReviews) * 10) / 10) : "",
  String(m.countries.size),
]);

fs.writeFileSync(
  path.join(outDir, "myactivity_raw.csv"),
  serializeCsv(["date", "time", "product", "action", "archive", "member"], activityRaw.map((r) => [r.date, r.time, r.product, r.action, r.archive, r.member])),
  "utf8",
);
fs.writeFileSync(
  path.join(outDir, "myactivity_daily.csv"),
  serializeCsv(["date", "activities", "searches", "visits", "watched", "viewed", "products"], activityRows),
  "utf8",
);
fs.writeFileSync(
  path.join(outDir, "timeline_semantic_daily.csv"),
  serializeCsv(["date", "segments", "visits", "activities", "visit_minutes", "moving_minutes", "distance_meters", "unique_places"], timelineRows),
  "utf8",
);
fs.writeFileSync(
  path.join(outDir, "fit_daily.csv"),
  serializeCsv(["date", "steps", "distance_meters", "calories", "active_minutes", "heart_minutes", "sleep_minutes", "heart_rate_samples", "heart_rate_avg", "heart_rate_min", "heart_rate_max"], fitRows),
  "utf8",
);
fs.writeFileSync(
  path.join(outDir, "calendar_daily.csv"),
  serializeCsv(["date", "events", "timed_events", "all_day_events", "event_minutes", "calendars"], calendarRows),
  "utf8",
);
fs.writeFileSync(
  path.join(outDir, "maps_places_daily.csv"),
  serializeCsv(["date", "saved_places", "reviews", "rated_reviews", "avg_rating", "countries"], mapsPlacesRows),
  "utf8",
);

const myActivityMerge = mergeDailyCsv(recordDir(), "google_myactivity", {
  header: ["date", "activities", "searches", "visits", "watched", "viewed", "products"],
  rows: activityRows,
});

const timelineMerge = mergeDailyCsv(recordDir(), "google_timeline_semantic", {
  header: ["date", "segments", "visits", "activities", "visit_minutes", "moving_minutes", "distance_meters", "unique_places"],
  rows: timelineRows,
});

const fitMerge = mergeDailyCsv(recordDir(), "google_fit", {
  header: ["date", "steps", "distance_meters", "calories", "active_minutes", "heart_minutes", "sleep_minutes", "heart_rate_samples", "heart_rate_avg", "heart_rate_min", "heart_rate_max"],
  rows: fitRows,
});

const calendarMerge = mergeDailyCsv(recordDir(), "google_calendar_takeout", {
  header: ["date", "events", "timed_events", "all_day_events", "event_minutes", "calendars"],
  rows: calendarRows,
});

const mapsPlacesMerge = mergeDailyCsv(recordDir(), "google_maps_places", {
  header: ["date", "saved_places", "reviews", "rated_reviews", "avg_rating", "countries"],
  rows: mapsPlacesRows,
});

const eventWrite = appendEvents(
  activityRaw.map((item) => {
    const url = item.action.match(/\bhttps?:\/\/\S+/i)?.[0] ?? null;
    const text = [item.product, item.action].filter(Boolean).join(" - ") || item.product || "Google activity";
    return {
      source: "google_myactivity",
      date: item.date,
      ts: item.time,
      title: item.action || item.product,
      text,
      url,
      meta: { product: item.product, archive: item.archive, member: item.member },
    };
  }),
  { recordDir: recordDir() },
);

// Calendar events land in the events store too — titles become searchable
// (recall/FTS), not just daily counts.
const calendarEventWrite = appendEvents(calendarEventRows, { recordDir: recordDir() });

// A skipped member is DATA THAT DID NOT LAND — persist it as a pending
// notification (stable id: same skip never re-notifies), never just a console
// line that scrolls away.
if (calendarSkippedMembers.length) {
  const skipId = crypto.createHash("sha256").update(calendarSkippedMembers.join("\n")).digest("hex").slice(0, 16);
  appendInboxItems(
    [{
      id: `takeout-skip-${skipId}`,
      text:
        `Takeout import skipped ${calendarSkippedMembers.length} calendar file(s) — this data is NOT in the record:\n` +
        calendarSkippedMembers.map((m) => `  ${m}`).join("\n"),
      source: "import",
      kind: "notification",
      meta: { kind: "import-skip", members: calendarSkippedMembers },
    }],
    { recordDir: recordDir() },
  );
}

const rebuilt = rebuild();
console.log(`archives=${zips.length}`);
console.log(`myactivity_files=${activityFiles} raw_items=${activityRaw.length} days=${activityRows.length} merged_cells=${myActivityMerge.cells}`);
console.log(`timeline_files=${timelineFiles} segments=${timelineSegments} days=${timelineRows.length} merged_cells=${timelineMerge.cells}`);
console.log(`fit_files=${fitFiles} points=${fitPoints} days=${fitRows.length} merged_cells=${fitMerge.cells}`);
console.log(`calendar_files=${calendarFiles} skipped=${calendarSkipped} events=${calendarEvents} days=${calendarRows.length} merged_cells=${calendarMerge.cells} indexed_events=${calendarEventWrite.added}`);
console.log(`maps_places_files=${mapsPlacesFiles} items=${mapsPlacesItems} days=${mapsPlacesRows.length} merged_cells=${mapsPlacesMerge.cells}`);
console.log(`event_rows_added=${eventWrite.added} event_rows_total=${eventWrite.total}`);
console.log(`out=${outDir}`);
console.log(`rebuilt_daily_rows=${rebuilt.daily} rebuilt_event_rows=${rebuilt.events}`);
