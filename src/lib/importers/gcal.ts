import {
  getJson,
  num,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Google Calendar — meetings, and how they land on your day. Uses the Events list
 * on the primary calendar, expanding recurrences:
 *
 *   GET https://www.googleapis.com/calendar/v3/calendars/primary/events
 *       ?timeMin=<from>T00:00:00Z&timeMax=<to>T23:59:59Z&singleEvents=true
 *
 * Auth is an OAuth 2 bearer access token (paste one, same slot GitHub's PAT uses).
 * Timed events are bucketed by their start day into a per-day count + total hours;
 * all-day events (date-only, no time) are ignored so "meeting_hours" stays real.
 */

interface GEvent {
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}
interface GList {
  items?: GEvent[];
}

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export function normalizeCalendar(events: GEvent[]): DailyTable {
  const count = new Map<string, number>();
  const hours = new Map<string, number>();
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    const startISO = ev.start?.dateTime;
    const endISO = ev.end?.dateTime;
    if (!startISO) continue; // all-day (date-only) → not a meeting
    const day = startISO.slice(0, 10);
    count.set(day, (count.get(day) ?? 0) + 1);
    if (endISO) {
      const dur = (new Date(endISO).getTime() - new Date(startISO).getTime()) / 3_600_000;
      if (Number.isFinite(dur) && dur > 0) hours.set(day, (hours.get(day) ?? 0) + dur);
    }
  }
  const header = ["date", "meetings", "meeting_hours"];
  const rows = [...count.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(count.get(d) ?? 0), num(hours.get(d) ?? 0)]);
  return { header, rows };
}

export const gcalPlugin: ImporterPlugin = {
  id: "gcal",
  name: "Google Calendar",
  detail: "meetings & hours per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "ya29.… (OAuth access token)",
  credentialHelp: {
    url: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "In Google Cloud Console, create a project and enable the Google Calendar API.",
      "Configure the OAuth consent screen (External) and add your own Google account as a test user.",
      "Credentials → Create OAuth client ID → Web application, with the Redirect URI shown here.",
      "Paste the Client ID and Client Secret into the fields here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    tokenAuth: "body",
    // offline + consent → Google actually returns a refresh token, every time.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  envKey: "GCAL_TOKEN",
  primaryMetric: "meetings",
  unit: "meetings",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    url.searchParams.set("timeMin", `${ctx.from}T00:00:00Z`);
    url.searchParams.set("timeMax", `${ctx.to}T23:59:59Z`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "2500");
    let raw: unknown;
    try {
      raw = await getJson(
        url.toString(),
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Google Calendar events → ${(e as Error).message}`);
    }
    const events = (raw as GList)?.items ?? [];
    return { table: normalizeCalendar(events), meta: { pulledEvents: events.length } };
  },
};
