import {
  getJson,
  inWindow,
  splitCredential,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Trakt — what you watched. Uses the personal watch history for the window:
 *
 *   GET https://api.trakt.tv/users/me/history
 *       ?start_at=<from>T00:00:00Z&end_at=<to>T23:59:59Z&limit=100
 *
 * Auth needs the app client id (trakt-api-key header) AND an OAuth access token, so
 * the single credential slot takes both as "<client_id>:<access_token>". Plays are
 * bucketed by their watched-at day into a per-day play count.
 */

interface TraktPlay {
  watched_at?: string;
}

const API = "https://api.trakt.tv/users/me/history";

export function normalizeTrakt(plays: TraktPlay[], from: string, to: string): DailyTable {
  const count = new Map<string, number>();
  for (const p of plays) {
    const day = (p.watched_at ?? "").slice(0, 10);
    if (!day || !inWindow(day, from, to)) continue;
    count.set(day, (count.get(day) ?? 0) + 1);
  }
  const header = ["date", "plays"];
  const rows = [...count.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(count.get(d) ?? 0)]);
  return { header, rows };
}

export const traktPlugin: ImporterPlugin = {
  id: "trakt",
  name: "Trakt",
  detail: "shows & movies watched",
  live: true,
  requiresCredential: true,
  credentialLabel: "client id + access token",
  credentialPlaceholder: "<client_id>:<access_token>",
  credentialHelp: {
    url: "https://trakt.tv/oauth/applications",
    steps: [
      "Create an API app at trakt.tv (any name).",
      "Set the Redirect URI to the one shown here.",
      "Paste the Client ID and Client Secret into the fields here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://trakt.tv/oauth/authorize",
    tokenUrl: "https://api.trakt.tv/oauth/token",
    scope: "", // Trakt has no scopes
    tokenAuth: "body",
    tokenBody: "json", // Trakt's token endpoint only accepts JSON
    // Data calls need the app client id (trakt-api-key header) AND the token —
    // hand syncs the plugin's own "<client_id>:<access_token>" format.
    grantCredential: "clientId:token",
  },
  envKey: "TRAKT_TOKEN",
  primaryMetric: "plays",
  unit: "plays",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const [clientId, token] = splitCredential(ctx.credential);
    const url = new URL(API);
    url.searchParams.set("start_at", `${ctx.from}T00:00:00Z`);
    url.searchParams.set("end_at", `${ctx.to}T23:59:59Z`);
    url.searchParams.set("limit", "100");
    let raw: unknown;
    try {
      raw = await getJson(
        url.toString(),
        {
          "trakt-api-key": clientId,
          "trakt-api-version": "2",
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Trakt history → ${(e as Error).message}`);
    }
    const plays = Array.isArray(raw) ? (raw as TraktPlay[]) : [];
    return { table: normalizeTrakt(plays, ctx.from, ctx.to), meta: { pulledPlays: plays.length } };
  },
};
