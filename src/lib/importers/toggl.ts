import {
  getJson,
  windowChunks,
  inWindow,
  num,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Toggl Track — where your tracked hours went. Uses the v9 time-entries list:
 *
 *   GET https://api.track.toggl.com/api/v9/me/time_entries
 *       ?start_date=<from>&end_date=<to>
 *
 * Auth is an API token (Toggl uses HTTP Basic "<token>:api_token"). Entries are
 * bucketed by their start day into a per-day count + tracked hours; a still-running
 * entry (negative duration) is skipped.
 */

interface TogglEntry {
  start?: string;
  duration?: number; // seconds; negative while running
}

/** Toggl will not answer a longer range in one request. */
const MAX_RANGE_DAYS = 90;
const API = "https://api.track.toggl.com/api/v9/me/time_entries";

export function normalizeToggl(entries: TogglEntry[], from: string, to: string): DailyTable {
  const count = new Map<string, number>();
  const seconds = new Map<string, number>();
  for (const e of entries) {
    const day = (e.start ?? "").slice(0, 10);
    if (!day || !inWindow(day, from, to)) continue;
    if (typeof e.duration !== "number" || e.duration < 0) continue; // running entry
    count.set(day, (count.get(day) ?? 0) + 1);
    seconds.set(day, (seconds.get(day) ?? 0) + e.duration);
  }
  const header = ["date", "entries", "tracked_hours"];
  const rows = [...count.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(count.get(d) ?? 0), num((seconds.get(d) ?? 0) / 3600)]);
  return { header, rows };
}

export const togglPlugin: ImporterPlugin = {
  id: "toggl",
  name: "Toggl Track",
  detail: "tracked entries & hours",
  live: true,
  requiresCredential: true,
  credentialLabel: "Toggl API token",
  credentialPlaceholder: "your Toggl API token",
  credentialHelp: {
    url: "https://track.toggl.com/profile",
    steps: [
      "Open your Toggl Track Profile page and scroll to the bottom.",
      "Reveal the API Token and paste it here.",
    ],
  },
  envKey: "TOGGL_TOKEN",
  primaryMetric: "tracked_hours",
  unit: "hours",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // Toggl will not answer a range of many months in one request, and it does not
    // paginate — it just returns what it feels like. Handing it a 365-day backfill
    // chunk and counting whatever came back is how a year becomes a fortnight with no
    // error anywhere. Ask in windows it will actually serve.
    const basic = Buffer.from(`${ctx.credential ?? ""}:api_token`).toString("base64");
    const entries: TogglEntry[] = [];
    for (const w of windowChunks(ctx.from, ctx.to, MAX_RANGE_DAYS)) {
      const url = new URL(API);
      url.searchParams.set("start_date", w.from);
      url.searchParams.set("end_date", w.to);
      let raw: unknown;
      try {
        raw = await getJson(
          url.toString(),
          { Authorization: `Basic ${basic}`, Accept: "application/json" },
          fetchImpl,
        );
      } catch (e) {
        throw new Error(`Toggl time entries (${w.from}..${w.to}) → ${(e as Error).message}`);
      }
      entries.push(...(Array.isArray(raw) ? (raw as TogglEntry[]) : []));
    }
    return { table: normalizeToggl(entries, ctx.from, ctx.to), meta: { pulledEntries: entries.length } };
  },
};
