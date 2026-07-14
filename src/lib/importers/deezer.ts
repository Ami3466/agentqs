import {
  getJson,
  pageAll,
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Deezer — tracks you played (listening history). Single request:
 *
 *   GET https://api.deezer.com/user/me/history?access_token=<token>&limit=200
 *
 * Auth is an OAuth access token (scope `listening_history`). Each history entry
 * carries a unix `timestamp`; plays are bucketed by their listen day into a
 * per-day count.
 */

interface DeezerPlay {
  timestamp?: number;
}
interface DeezerResp {
  data?: DeezerPlay[];
  /** Deezer answers HTTP 200 even for auth failures — the error rides the body. */
  error?: { type?: string; message?: string; code?: number };
}

const PER_PAGE = 200;
const API = "https://api.deezer.com/user/me/history";

export function normalizeDeezer(plays: DeezerPlay[], from: string, to: string): DailyTable {
  const byDay = new Map<string, number>();
  for (const p of plays) {
    const ts = Number(p.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    if (!inWindow(day, from, to)) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const header = ["date", "plays"];
  const rows = [...byDay.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(byDay.get(d) ?? 0)]);
  return { header, rows };
}

export const deezerPlugin: ImporterPlugin = {
  id: "deezer",
  name: "Deezer",
  detail: "tracks played per day",
  live: true,
  // A partial view never lowers a fuller one: the history feed returns the newest ~200 plays and takes no date range, so a day is recomputed from whatever slice of it is still in that buffer.
  // Replacing on every sync made each day decay toward zero as the buffer slid
  // past it, and ate an imported lifetime export the moment a sync touched one of
  // its days. A shorter look is not news. See MergePolicy in record.ts.
  mergePolicy: "max",
  requiresCredential: true,
  credentialLabel: "Deezer access token",
  credentialPlaceholder: "your Deezer OAuth access token",
  credentialHelp: {
    url: "https://developers.deezer.com",
    steps: [
      "Deezer stopped accepting NEW app registrations — this only works with an existing Deezer API app.",
      "With an existing app, mint a token via their OAuth flow (scope listening_history) and paste it here.",
    ],
  },
  envKey: "DEEZER_TOKEN",
  primaryMetric: "plays",
  unit: "plays",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // Deezer's history takes no date range but it DOES page (`index`), newest first.
    // Reading one page meant the last ~200 plays were the only history that existed —
    // every older backfill chunk filtered to zero and the walk gave up. Paging back
    // until the plays fall out of the window makes the real history reachable.
    let plays: DeezerPlay[];
    try {
      plays = await pageAll<DeezerPlay>("Deezer history", async (cursor) => {
        const url = new URL(API);
        url.searchParams.set("access_token", ctx.credential ?? "");
        url.searchParams.set("limit", String(PER_PAGE));
        if (cursor) url.searchParams.set("index", String(cursor));
        const raw = (await getJson(url.toString(), { Accept: "application/json" }, fetchImpl)) as DeezerResp;
        // A bad token is HTTP 200 + {error} — without this check it would read as
        // a successful sync with zero plays.
        const err = raw?.error;
        if (err) {
          throw new Error(`${err.type ?? "error"} ${err.code ?? ""}: ${err.message ?? "request failed"}`);
        }
        const batch = raw?.data ?? [];
        const index = Number(cursor ?? 0);
        // Newest-first: once the page's OLDEST play predates the window, there is
        // nothing left here for us.
        const oldest = batch.at(-1)?.timestamp;
        const past = typeof oldest === "number" && new Date(oldest * 1000).toISOString().slice(0, 10) < ctx.from;
        const more = batch.length === PER_PAGE && !past;
        return { items: batch, next: more ? index + PER_PAGE : null };
      });
    } catch (e) {
      throw new Error(`Deezer history → ${(e as Error).message}`);
    }
    return { table: normalizeDeezer(plays, ctx.from, ctx.to), meta: { pulledPlays: plays.length } };
  },
};
