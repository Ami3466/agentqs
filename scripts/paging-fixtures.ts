/**
 * MULTI-PAGE fixtures — the thing whose absence hid the worst bug in this codebase.
 *
 * Every plugin fixture was a small single-page blob, so a plugin that stopped at page
 * one passed the exact same test as one that followed the cursor to the end. Thirteen
 * of eighteen importers stopped at page one, for years, with every test green.
 *
 * So: each spec below serves TWO pages, in that API's own paging protocol — page 1 on
 * day A, page 2 on day B. A plugin that ignores the cursor sees only day A. The test
 * asserts BOTH days land, which no non-paging plugin can do.
 *
 * `full` is the page size the plugin treats as "there is probably more" — for an API
 * with no total and no cursor (Strava, Trakt, Deezer, Swarm, Mastodon), a FULL page is
 * the only signal that another exists, so page 1 must actually be full.
 */
export interface PagingSpec {
  /** Page size that means "keep going". 1 when the API hands back an explicit cursor. */
  full: number;
  credential?: string;
  /** Which page is being asked for (0-based), read from the request. */
  pageOf: (u: URL, body: Record<string, unknown>) => number;
  /** One item, played/logged/committed on `day`. */
  item: (day: string, i: number) => unknown;
  /** Wrap a page of items in the API's own envelope. */
  wrap: (items: unknown[], page: number, last: boolean) => unknown;
}

const iso = (day: string) => `${day}T12:00:00Z`;
const unix = (day: string) => Math.floor(Date.parse(iso(day)) / 1000);

export const PAGING: Record<string, PagingSpec> = {
  lastfm: {
    full: 1, // it reports totalPages, so one item is enough to prove the walk
    credential: "APIKEY:testuser",
    pageOf: (u) => Number(u.searchParams.get("page") ?? 1) - 1,
    item: (day) => ({ date: { uts: String(unix(day)) } }),
    wrap: (items, page, last) => ({
      recenttracks: { track: items, "@attr": { page: String(page + 1), totalPages: last ? String(page + 1) : "2" } },
    }),
  },
  strava: {
    full: 200, // no total, no cursor — only a FULL page says "ask again"
    pageOf: (u) => Number(u.searchParams.get("page") ?? 1) - 1,
    item: (day) => ({ start_date_local: iso(day), distance: 1000, moving_time: 600 }),
    wrap: (items) => items,
  },
  trakt: {
    full: 100,
    credential: "CLIENTID:ACCESSTOKEN",
    pageOf: (u) => Number(u.searchParams.get("page") ?? 1) - 1,
    item: (day) => ({ watched_at: iso(day) }),
    wrap: (items) => items,
  },
  gcal: {
    full: 1,
    pageOf: (u) => Number(u.searchParams.get("pageToken") ?? 0),
    item: (day) => ({ start: { dateTime: iso(day) }, end: { dateTime: `${day}T13:00:00Z` } }),
    wrap: (items, page, last) => ({ items, ...(last ? {} : { nextPageToken: String(page + 1) }) }),
  },
  oura: {
    full: 1,
    pageOf: (u) => Number(u.searchParams.get("next_token") ?? 0),
    item: (day) => ({ day, score: 80 }),
    wrap: (items, page, last) => ({ data: items, ...(last ? {} : { next_token: String(page + 1) }) }),
  },
  withings: {
    full: 1,
    pageOf: (u) => Number(new URL(u).searchParams.get("offset") ?? 0),
    item: (day) => ({ date: unix(day), measures: [{ value: 80000, unit: -3, type: 1 }] }),
    wrap: (items, page, last) => ({
      status: 0,
      body: { measuregrps: items, ...(last ? {} : { more: 1, offset: page + 1 }) },
    }),
  },
  deezer: {
    full: 200,
    pageOf: (u) => Number(u.searchParams.get("index") ?? 0) / 200,
    item: (day) => ({ timestamp: unix(day) }),
    wrap: (items) => ({ data: items }),
  },
  swarm: {
    full: 200,
    pageOf: (u) => Number(u.searchParams.get("offset") ?? 0) / 200,
    item: (day) => ({ createdAt: unix(day) }),
    wrap: (items) => ({ response: { checkins: { items } } }),
  },
  mastodon: {
    full: 40,
    credential: "mastodon.example:ACCESSTOKEN",
    // max_id is the id of the last item we served, and ids count down from 1000.
    pageOf: (u) => (u.searchParams.has("max_id") ? 1 : 0),
    item: (day, i) => ({ id: String(1000 - i), created_at: iso(day) }),
    wrap: (items) => items,
  },
  notion: {
    full: 1,
    pageOf: (_u, body) => Number(body.start_cursor ?? 0),
    item: (day) => ({ last_edited_time: iso(day) }),
    wrap: (items, page, last) => ({
      results: items,
      ...(last ? { has_more: false } : { has_more: true, next_cursor: String(page + 1) }),
    }),
  },
  todoist: {
    full: 1,
    pageOf: (u) => Number(u.searchParams.get("cursor") ?? 0),
    item: (day) => ({ completed_at: iso(day) }),
    wrap: (items, page, last) => ({ items, ...(last ? { next_cursor: null } : { next_cursor: String(page + 1) }) }),
  },
};

/**
 * A fetch that serves exactly two pages: `full` items on `dayA`, then one on `dayB`.
 * Also counts requests, so a plugin that never asks for page 2 is visible.
 */
export function pagingFetch(spec: PagingSpec, dayA: string, dayB: string) {
  const seen: number[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
    }
    // Mastodon's account lookup comes first and is not a page.
    if (u.pathname.includes("verify_credentials")) {
      return new Response(JSON.stringify({ id: "42" }), { status: 200 });
    }
    const page = spec.pageOf(u, body);
    seen.push(page);
    const last = page >= 1;
    const items = last
      ? [spec.item(dayB, 0)]
      : Array.from({ length: spec.full }, (_, i) => spec.item(dayA, i));
    return new Response(JSON.stringify(spec.wrap(items, page, last)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, seen };
}
