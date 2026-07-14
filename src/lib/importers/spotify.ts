import {
  getJson,
  inWindow,
  num,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Spotify — what you listened to. Uses Recently Played (the endpoint that needs no
 * scopes beyond user-read-recently-played):
 *
 *   GET https://api.spotify.com/v1/me/player/recently-played?limit=50
 *
 * Auth is an OAuth 2 bearer access token (paste one). Plays are bucketed by their
 * `played_at` day into a per-day track count + total minutes listened.
 */

interface SpotifyItem {
  played_at?: string;
  track?: { duration_ms?: number };
}
interface SpotifyList {
  items?: SpotifyItem[];
  cursors?: { before?: string; after?: string };
}

const API = "https://api.spotify.com/v1/me/player/recently-played?limit=50";

/** Stop paging. Spotify's own ceiling is ~50 plays, so this is only a guard against
 *  an endpoint that never says "no more" — not a window, and not a cap on history:
 *  history comes from the export, which is finite and read WHOLE. */
const MAX_PAGES = 20;

export function normalizeSpotify(items: SpotifyItem[], from: string, to: string): DailyTable {
  const tracks = new Map<string, number>();
  const ms = new Map<string, number>();
  for (const it of items) {
    const played = it.played_at;
    if (!played) continue;
    const day = played.slice(0, 10);
    if (!inWindow(day, from, to)) continue;
    tracks.set(day, (tracks.get(day) ?? 0) + 1);
    const d = it.track?.duration_ms;
    if (typeof d === "number" && d > 0) ms.set(day, (ms.get(day) ?? 0) + d);
  }
  const header = ["date", "tracks", "minutes"];
  const rows = [...tracks.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(tracks.get(d) ?? 0), num((ms.get(d) ?? 0) / 60_000)]);
  return { header, rows };
}

export const spotifyPlugin: ImporterPlugin = {
  id: "spotify",
  name: "Spotify",
  detail: "tracks & minutes listened",
  live: true,
  // Spotify serves the last 50 plays and takes NO date range — the window is a
  // client-side filter over whatever comes back, so it must stay WIDE (the default).
  // Narrowing it to "the last few days" would DISCARD those plays whenever you had
  // not listened recently, turning a quiet fortnight into zero rows. The handful of
  // days a sync covers is Spotify's 50-item ceiling, not a broken importer.
  historyNote:
    "Spotify's API only returns your last ~50 plays and accepts no date range, so a sync covers a few days at most — that is Spotify's limit, not a failed import. Your listening history lives in the account export (Spotify → Privacy Settings → Extended streaming history): drop the zip into Data, or run `agentqs source file spotify --path <my_spotify_data.zip>`. It lands in this same source, so Spotify shows the lifetime and the sync keeps the last few days fresh.",
  // A partial view never lowers a fuller one: recently-played serves the last ~50 plays and takes no date range, so a day is recomputed from whatever slice of it is still in that buffer.
  // Replacing on every sync made each day decay toward zero as the buffer slid
  // past it, and ate an imported lifetime export the moment a sync touched one of
  // its days. A shorter look is not news. See MergePolicy in record.ts.
  mergePolicy: "max",
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "BQ… (OAuth access token)",
  credentialHelp: {
    url: "https://developer.spotify.com/dashboard",
    steps: [
      "Create an app in the Spotify developer dashboard (any name; Web API checked).",
      "Under the app's settings, add the Redirect URI shown here EXACTLY — Spotify accepts http://127.0.0.1:<port>/… but rejects \"localhost\", so open agentqs via 127.0.0.1.",
      "Copy the app's Client ID and Client Secret into the fields here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    scope: "user-read-recently-played",
    tokenAuth: "basic",
  },
  envKey: "SPOTIFY_TOKEN",
  primaryMetric: "tracks",
  unit: "tracks",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const headers = { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" };
    // Page BACKWARD with the `before` cursor and take everything Spotify is willing
    // to serve, rather than only the first 50 items it hands over. Today that pool
    // usually IS 50 — the loop then ends on its own after one more page — but reading
    // a single page was a cap we chose, on top of the one Spotify imposes, and only
    // one of those is real.
    const items: SpotifyItem[] = [];
    // A play is uniquely its timestamp, so the SAME play can never be counted twice.
    // This is not belt-and-braces: at the end of the 50-play pool Spotify hands back
    // a cursor that returns the very same page, and pushing a batch before noticing
    // it had not moved DOUBLED every track and minute on those days.
    const seen = new Set<string>();
    let url = API;
    let pages = 0;
    try {
      while (pages++ < MAX_PAGES) {
        const page = (await getJson(url, headers, fetchImpl)) as SpotifyList;
        const batch = (page?.items ?? []).filter((it) => {
          const at = it.played_at;
          if (!at || seen.has(at)) return false;
          seen.add(at);
          return true;
        });
        // Nothing here we had not already counted → the pool is exhausted.
        if (!batch.length) break;
        items.push(...batch);
        const last = batch.at(-1)?.played_at ?? "";
        if (!last) break;
        if (last.slice(0, 10) < ctx.from) break; // past the window we were asked for
        const before = page.cursors?.before ?? String(Date.parse(last));
        if (!before || before === "NaN") break;
        url = `${API}&before=${before}`;
      }
    } catch (e) {
      throw new Error(`Spotify recently-played → ${(e as Error).message}`);
    }
    return {
      table: normalizeSpotify(items, ctx.from, ctx.to),
      meta: {
        pulledPlays: items.length,
        pages: pages - 1,
        // Say it on every sync, so a thin result never reads as a broken importer.
        note:
          "Spotify serves only your most recent plays (~50) and accepts no date range. " +
          "For your listening history, import the account export: agentqs source file spotify --path <my_spotify_data.zip>",
      },
    };
  },
};
