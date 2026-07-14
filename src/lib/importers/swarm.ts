import {
  getJson,
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Swarm (Foursquare) — places you checked in. Single request to the v2 API:
 *
 *   GET https://api.foursquare.com/v2/users/self/checkins
 *       ?oauth_token=<token>&v=20240101&limit=200&sort=newestfirst
 *
 * Auth is a Foursquare OAuth token. Each check-in carries a unix `createdAt`;
 * check-ins are bucketed by their day into a per-day count.
 */

interface SwarmCheckin {
  createdAt?: number;
}
interface SwarmResp {
  response?: { checkins?: { items?: SwarmCheckin[] } };
}

const API = "https://api.foursquare.com/v2/users/self/checkins";

export function normalizeSwarm(items: SwarmCheckin[], from: string, to: string): DailyTable {
  const byDay = new Map<string, number>();
  for (const c of items) {
    const ts = Number(c.createdAt);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    if (!inWindow(day, from, to)) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const header = ["date", "checkins"];
  const rows = [...byDay.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(byDay.get(d) ?? 0)]);
  return { header, rows };
}

export const swarmPlugin: ImporterPlugin = {
  id: "swarm",
  name: "Swarm",
  detail: "check-ins per day",
  live: true,
  // A partial view never lowers a fuller one: the check-ins feed returns the newest ~200 and takes no date range, so a day is recomputed from whatever slice of it is still in that buffer.
  // Replacing on every sync made each day decay toward zero as the buffer slid
  // past it, and ate an imported lifetime export the moment a sync touched one of
  // its days. A shorter look is not news. See MergePolicy in record.ts.
  mergePolicy: "max",
  requiresCredential: true,
  credentialLabel: "Foursquare access token",
  credentialPlaceholder: "your Foursquare OAuth token",
  credentialHelp: {
    url: "https://foursquare.com/developers/home",
    steps: [
      "Create a project/app in the Foursquare developer console and note its Client ID + Secret.",
      "Run their OAuth flow once (foursquare.com/oauth2/authenticate → code → /oauth2/access_token, per their docs).",
      "Paste the resulting user token here — Foursquare user tokens do not expire.",
    ],
  },
  envKey: "SWARM_TOKEN",
  primaryMetric: "checkins",
  unit: "check-ins",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    url.searchParams.set("oauth_token", ctx.credential ?? "");
    url.searchParams.set("v", "20240101");
    url.searchParams.set("limit", "200");
    url.searchParams.set("sort", "newestfirst");
    let raw: unknown;
    try {
      raw = await getJson(url.toString(), { Accept: "application/json" }, fetchImpl);
    } catch (e) {
      throw new Error(`Swarm check-ins → ${(e as Error).message}`);
    }
    const items = (raw as SwarmResp)?.response?.checkins?.items ?? [];
    return { table: normalizeSwarm(items, ctx.from, ctx.to), meta: { pulledCheckins: items.length } };
  },
};
