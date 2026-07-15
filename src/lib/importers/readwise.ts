import {
  getJson,
  inWindow,
  localDay,
  pageAll,
  recordTimeZone,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Readwise — how much you highlighted (read closely) per day. Uses the v2
 * highlights list:
 *
 *   GET https://readwise.io/api/v2/highlights/?page_size=1000&page=<n>
 *
 * Auth is your access token (`Authorization: Token <key>`) — paste one from
 * readwise.io/access_token, no OAuth. The endpoint isn't date-ordered and takes no
 * date range, so we page to the END (pageAll throws rather than truncating), bucket
 * every highlight by the LOCAL day it was made (`highlighted_at` is UTC), and keep
 * the days inside the sync window.
 */

interface RwHighlight {
  highlighted_at?: string | null; // ISO, UTC (or null for undated)
}
interface RwPage {
  count?: number;
  next?: string | null;
  results?: RwHighlight[];
}

const API = "https://readwise.io/api/v2/highlights/";

export function normalizeReadwise(
  highlights: RwHighlight[],
  from: string,
  to: string,
  tz: string = recordTimeZone(),
): DailyTable {
  const perDay = new Map<string, number>();
  for (const h of highlights) {
    if (!h.highlighted_at) continue;
    const day = localDay(h.highlighted_at, tz);
    if (!day || !inWindow(day, from, to)) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const rows = [...perDay.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(perDay.get(d) ?? 0)]);
  return { header: ["date", "highlights"], rows };
}

export const readwisePlugin: ImporterPlugin = {
  id: "readwise",
  name: "Readwise",
  detail: "highlights made per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "Readwise access token",
  credentialPlaceholder: "your Readwise access token",
  credentialHelp: {
    url: "https://readwise.io/access_token",
    steps: [
      "Sign in to Readwise and open readwise.io/access_token.",
      "Copy the token shown there and paste it here — it does not expire.",
    ],
  },
  envKey: "READWISE_TOKEN",
  primaryMetric: "highlights",
  unit: "highlights",
  // The highlights endpoint takes no date range, so a sync reads the whole library
  // and keeps the days in-window — a large library is paged to the end, never clipped.
  historyNote:
    "Readwise's API serves your highlights without a date filter, so each sync reads the full library and buckets it by day. Your whole highlighting history lands on the first import.",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    let highlights: RwHighlight[];
    try {
      highlights = await pageAll<RwHighlight>("Readwise highlights", async (_cursor, page) => {
        const url = new URL(API);
        url.searchParams.set("page_size", "1000");
        url.searchParams.set("page", String(page));
        const raw = (await getJson(
          url.toString(),
          { Authorization: `Token ${ctx.credential ?? ""}`, Accept: "application/json" },
          fetchImpl,
        )) as RwPage;
        return { items: raw?.results ?? [], next: raw?.next ? page + 1 : null };
      });
    } catch (e) {
      throw new Error(`Readwise highlights → ${(e as Error).message}`);
    }
    const table = normalizeReadwise(highlights, ctx.from, ctx.to);
    return { table, meta: { pulledHighlights: highlights.length, days: table.rows.length } };
  },
};
