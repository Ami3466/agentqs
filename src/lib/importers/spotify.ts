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
}

const API = "https://api.spotify.com/v1/me/player/recently-played?limit=50";

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
    let raw: unknown;
    try {
      raw = await getJson(
        API,
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Spotify recently-played → ${(e as Error).message}`);
    }
    const items = (raw as SpotifyList)?.items ?? [];
    return { table: normalizeSpotify(items, ctx.from, ctx.to), meta: { pulledPlays: items.length } };
  },
};
