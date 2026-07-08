import fs from "fs";
import path from "path";
import { appendEvents, mergeDailyCsv, rebuild, serializeCsv } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const input = arg("--path") ?? path.join(process.env.HOME ?? "", "Downloads", "location-history.json");
const outDir = arg("--out") ?? path.join(process.cwd(), "tmp", "google-timeline");

interface TimelineSegment {
  startTime?: string;
  endTime?: string;
  visit?: {
    topCandidate?: {
      semanticType?: string;
      placeID?: string;
      placeLocation?: string;
      probability?: string;
    };
    probability?: string;
  };
  activity?: {
    topCandidate?: { type?: string; probability?: string };
    distanceMeters?: string;
    start?: string;
    end?: string;
    probability?: string;
  };
}

interface DailyAgg {
  segments: number;
  visits: number;
  activities: number;
  visitMinutes: number;
  movingMinutes: number;
  distanceMeters: number;
  homeVisits: number;
  searchedAddressVisits: number;
  uniquePlaces: Set<string>;
  walkingMeters: number;
  vehicleMeters: number;
  transitMeters: number;
  cyclingMeters: number;
  runningMeters: number;
  flyingMeters: number;
}

function emptyAgg(): DailyAgg {
  return {
    segments: 0,
    visits: 0,
    activities: 0,
    visitMinutes: 0,
    movingMinutes: 0,
    distanceMeters: 0,
    homeVisits: 0,
    searchedAddressVisits: 0,
    uniquePlaces: new Set<string>(),
    walkingMeters: 0,
    vehicleMeters: 0,
    transitMeters: 0,
    cyclingMeters: 0,
    runningMeters: 0,
    flyingMeters: 0,
  };
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function nextDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

function addDurationByDay(
  daily: Map<string, DailyAgg>,
  start: Date,
  end: Date,
  field: "visitMinutes" | "movingMinutes",
): void {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;
  let cursor = new Date(start);
  while (cursor < end) {
    const boundary = nextDay(cursor);
    const sliceEnd = boundary < end ? boundary : end;
    const date = localDate(cursor);
    const row = daily.get(date) ?? emptyAgg();
    row[field] += (sliceEnd.getTime() - cursor.getTime()) / 60000;
    daily.set(date, row);
    cursor = sliceEnd;
  }
}

function activityBucket(type: string): keyof DailyAgg | null {
  const t = type.toLowerCase();
  if (t.includes("walking")) return "walkingMeters";
  if (t.includes("cycling")) return "cyclingMeters";
  if (t.includes("running")) return "runningMeters";
  if (t.includes("vehicle")) return "vehicleMeters";
  if (t.includes("bus") || t.includes("subway") || t.includes("tram") || t.includes("ferry")) return "transitMeters";
  if (t.includes("flying")) return "flyingMeters";
  return null;
}

const raw = JSON.parse(fs.readFileSync(input, "utf8")) as unknown;
const segments: TimelineSegment[] = Array.isArray(raw)
  ? raw
  : Array.isArray((raw as { semanticSegments?: unknown }).semanticSegments)
    ? ((raw as { semanticSegments: TimelineSegment[] }).semanticSegments)
    : Array.isArray((raw as { timelineObjects?: unknown }).timelineObjects)
      ? ((raw as { timelineObjects: TimelineSegment[] }).timelineObjects)
      : [];

if (segments.length === 0) throw new Error(`No Timeline segments found in ${input}`);

fs.mkdirSync(outDir, { recursive: true });
const daily = new Map<string, DailyAgg>();
const rawRows: string[][] = [];
let first = "";
let last = "";

for (const seg of segments) {
  const start = seg.startTime ? new Date(seg.startTime) : null;
  const end = seg.endTime ? new Date(seg.endTime) : null;
  if (start && Number.isFinite(start.getTime())) {
    const date = localDate(start);
    const row = daily.get(date) ?? emptyAgg();
    row.segments++;
    daily.set(date, row);
    const iso = start.toISOString();
    if (!first || iso < first) first = iso;
    if (!last || iso > last) last = iso;
  }
  if (end && Number.isFinite(end.getTime())) {
    const iso = end.toISOString();
    if (!first || iso < first) first = iso;
    if (!last || iso > last) last = iso;
  }

  const startDate = start && Number.isFinite(start.getTime()) ? localDate(start) : "";
  const row = startDate ? (daily.get(startDate) ?? emptyAgg()) : null;
  if (row && !daily.has(startDate)) daily.set(startDate, row);

  if (seg.visit) {
    if (row) {
      row.visits++;
      const semantic = seg.visit.topCandidate?.semanticType ?? "";
      if (semantic === "Home") row.homeVisits++;
      if (semantic === "Searched Address") row.searchedAddressVisits++;
      const place = seg.visit.topCandidate?.placeID || seg.visit.topCandidate?.placeLocation;
      if (place) row.uniquePlaces.add(place);
    }
    if (start && end) addDurationByDay(daily, start, end, "visitMinutes");
    rawRows.push([
      start?.toISOString() ?? "",
      end?.toISOString() ?? "",
      "visit",
      seg.visit.topCandidate?.semanticType ?? "",
      "",
      "",
      seg.visit.topCandidate?.placeID ?? "",
      seg.visit.topCandidate?.placeLocation ?? "",
    ]);
  }

  if (seg.activity) {
    const distance = Number(seg.activity.distanceMeters ?? 0) || 0;
    const type = seg.activity.topCandidate?.type ?? "";
    if (row) {
      row.activities++;
      row.distanceMeters += distance;
      const bucket = activityBucket(type);
      if (bucket) (row[bucket] as number) += distance;
    }
    if (start && end) addDurationByDay(daily, start, end, "movingMinutes");
    rawRows.push([
      start?.toISOString() ?? "",
      end?.toISOString() ?? "",
      "activity",
      "",
      type,
      String(Math.round(distance)),
      "",
      `${seg.activity.start ?? ""} -> ${seg.activity.end ?? ""}`,
    ]);
  }
}

const header = [
  "date",
  "segments",
  "visits",
  "activities",
  "visit_minutes",
  "moving_minutes",
  "distance_meters",
  "home_visits",
  "searched_address_visits",
  "unique_places",
  "walking_meters",
  "vehicle_meters",
  "transit_meters",
  "cycling_meters",
  "running_meters",
  "flying_meters",
];

const rows = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, r]) => [
  date,
  String(r.segments),
  String(r.visits),
  String(r.activities),
  String(Math.round(r.visitMinutes)),
  String(Math.round(r.movingMinutes)),
  String(Math.round(r.distanceMeters)),
  String(r.homeVisits),
  String(r.searchedAddressVisits),
  String(r.uniquePlaces.size),
  String(Math.round(r.walkingMeters)),
  String(Math.round(r.vehicleMeters)),
  String(Math.round(r.transitMeters)),
  String(Math.round(r.cyclingMeters)),
  String(Math.round(r.runningMeters)),
  String(Math.round(r.flyingMeters)),
]);

fs.writeFileSync(
  path.join(outDir, "timeline_segments.csv"),
  serializeCsv(["start", "end", "kind", "semantic_type", "activity_type", "distance_meters", "place_id", "location"], rawRows),
  "utf8",
);
fs.writeFileSync(path.join(outDir, "timeline_daily.csv"), serializeCsv(header, rows), "utf8");

const merge = mergeDailyCsv(recordDir(), "google_timeline", { header, rows });
const eventWrite = appendEvents(
  rawRows.map((row) => {
    const [start, end, kind, semanticType, activityType, distanceMeters, placeId, location] = row;
    const date = start ? localDate(new Date(start)) : "";
    const title = kind === "visit" ? semanticType || "Visit" : activityType || "Activity";
    const detail =
      kind === "visit"
        ? `Visit${semanticType ? `: ${semanticType}` : ""}${location ? ` at ${location}` : ""}`
        : `Activity${activityType ? `: ${activityType}` : ""}${distanceMeters ? ` · ${distanceMeters} meters` : ""}`;
    return {
      source: "google_timeline",
      date,
      ts: start || undefined,
      title,
      text: [detail, end ? `until ${end}` : ""].filter(Boolean).join(" "),
      meta: { end, kind, semanticType, activityType, distanceMeters, placeId, location },
    };
  }).filter((event) => event.date),
  { recordDir: recordDir() },
);
const rebuilt = rebuild();

console.log(`input=${input}`);
console.log(`segments=${segments.length}`);
console.log(`span=${first || "?"}..${last || "?"}`);
console.log(`raw=${path.join(outDir, "timeline_segments.csv")}`);
console.log(`daily=${path.join(outDir, "timeline_daily.csv")}`);
console.log(`merged=${merge.rows} days cells=${merge.cells} file=${merge.file}`);
console.log(`event_rows_added=${eventWrite.added} event_rows_total=${eventWrite.total}`);
console.log(`rebuilt_daily_rows=${rebuilt.daily} rebuilt_event_rows=${rebuilt.events}`);
