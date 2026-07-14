import {
  getJson,
  pageAll,
  inWindow,
  splitCredential,
  unixSec,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Last.fm — scrobbles (what you actually played, everywhere). Uses the recent
 * tracks feed for the window:
 *
 *   GET https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks
 *       &user=<user>&api_key=<key>&from=<unix>&to=<unix>&limit=200&format=json
 *
 * Auth is an API key, and the endpoint also needs the username — so the single
 * credential slot takes both as "<api_key>:<username>". Scrobbles are bucketed by
 * their play day; the now-playing track (no date) is ignored.
 */

interface LfmTrack {
  date?: { uts?: string };
}
interface LfmResp {
  recenttracks?: {
    track?: LfmTrack[];
    /** Last.fm tells you how many pages it holds — we used to never look. */
    "@attr"?: { page?: string; totalPages?: string; total?: string };
  };
}

const API = "https://ws.audioscrobbler.com/2.0/";

export function normalizeLastfm(tracks: LfmTrack[], from: string, to: string): DailyTable {
  const scrobbles = new Map<string, number>();
  for (const t of tracks) {
    const uts = Number(t.date?.uts);
    if (!Number.isFinite(uts) || uts <= 0) continue; // now-playing has no date
    const day = new Date(uts * 1000).toISOString().slice(0, 10);
    if (!inWindow(day, from, to)) continue;
    scrobbles.set(day, (scrobbles.get(day) ?? 0) + 1);
  }
  const header = ["date", "scrobbles"];
  const rows = [...scrobbles.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(scrobbles.get(d) ?? 0)]);
  return { header, rows };
}

export const lastfmPlugin: ImporterPlugin = {
  id: "lastfm",
  name: "Last.fm",
  detail: "scrobbles per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "API key + username",
  credentialPlaceholder: "<api_key>:<username>",
  credentialHelp: {
    url: "https://www.last.fm/api/account/create",
    steps: [
      "Create an API account (any application name; callback URL can stay empty).",
      "Copy the API key and paste it here as api_key:your_lastfm_username.",
    ],
  },
  envKey: "LASTFM_KEY",
  primaryMetric: "scrobbles",
  unit: "scrobbles",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const [apiKey, user] = splitCredential(ctx.credential);
    // Last.fm serves 200 scrobbles a page and reports how many pages it holds. We
    // used to read page 1 and stop: a listener with ~10,000 scrobbles a year landed
    // 200 of them, and the record showed a decade at roughly 2% of what was played.
    let tracks: LfmTrack[];
    try {
      tracks = await pageAll<LfmTrack>("Last.fm recent tracks", async (cursor) => {
        const url = new URL(API);
        url.searchParams.set("method", "user.getrecenttracks");
        url.searchParams.set("user", user);
        url.searchParams.set("api_key", apiKey);
        url.searchParams.set("from", String(unixSec(ctx.from)));
        url.searchParams.set("to", String(unixSec(ctx.to, true)));
        url.searchParams.set("limit", "200");
        url.searchParams.set("page", String(cursor ?? 1));
        url.searchParams.set("format", "json");
        const raw = (await getJson(url.toString(), { Accept: "application/json" }, fetchImpl)) as LfmResp;
        const items = raw?.recenttracks?.track ?? [];
        const page = Number(raw?.recenttracks?.["@attr"]?.page ?? cursor ?? 1);
        const total = Number(raw?.recenttracks?.["@attr"]?.totalPages ?? 1);
        return { items, next: page < total ? page + 1 : null };
      });
    } catch (e) {
      throw new Error(`Last.fm recent tracks → ${(e as Error).message}`);
    }
    return { table: normalizeLastfm(tracks, ctx.from, ctx.to), meta: { pulledScrobbles: tracks.length } };
  },
};
