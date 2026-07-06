import {
  getJson,
  inWindow,
  num,
  unixSec,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Strava — training load. Uses the athlete Activities list, filtered to the window:
 *
 *   GET https://www.strava.com/api/v3/athlete/activities
 *       ?after=<unix>&before=<unix>&per_page=200
 *
 * Auth is an OAuth 2 bearer access token (paste one). Activities are bucketed by
 * their local start day into a per-day count + total km + moving hours.
 */

interface StravaActivity {
  start_date_local?: string;
  distance?: number; // metres
  moving_time?: number; // seconds
}

const API = "https://www.strava.com/api/v3/athlete/activities";

export function normalizeStrava(items: StravaActivity[], from: string, to: string): DailyTable {
  const count = new Map<string, number>();
  const metres = new Map<string, number>();
  const seconds = new Map<string, number>();
  for (const a of items) {
    const day = (a.start_date_local ?? "").slice(0, 10);
    if (!day || !inWindow(day, from, to)) continue;
    count.set(day, (count.get(day) ?? 0) + 1);
    if (typeof a.distance === "number") metres.set(day, (metres.get(day) ?? 0) + a.distance);
    if (typeof a.moving_time === "number") seconds.set(day, (seconds.get(day) ?? 0) + a.moving_time);
  }
  const header = ["date", "activities", "km", "moving_hours"];
  const rows = [...count.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [
      d,
      String(count.get(d) ?? 0),
      num((metres.get(d) ?? 0) / 1000),
      num((seconds.get(d) ?? 0) / 3600),
    ]);
  return { header, rows };
}

export const stravaPlugin: ImporterPlugin = {
  id: "strava",
  name: "Strava",
  detail: "activities, distance & moving time",
  live: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "Strava OAuth access token",
  envKey: "STRAVA_TOKEN",
  primaryMetric: "activities",
  unit: "activities",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    url.searchParams.set("after", String(unixSec(ctx.from)));
    url.searchParams.set("before", String(unixSec(ctx.to, true)));
    url.searchParams.set("per_page", "200");
    let raw: unknown;
    try {
      raw = await getJson(
        url.toString(),
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Strava activities → ${(e as Error).message}`);
    }
    const items = Array.isArray(raw) ? (raw as StravaActivity[]) : [];
    return { table: normalizeStrava(items, ctx.from, ctx.to), meta: { pulledActivities: items.length } };
  },
};
