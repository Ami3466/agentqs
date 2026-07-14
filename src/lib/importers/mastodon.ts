import {
  getJson,
  localDay,
  recordTimeZone,
  pageAll,
  inWindow,
  splitCredential,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Mastodon — posts per day. The fediverse is host-scoped, so the credential is a
 * combined `host:access-token` (e.g. `mastodon.social:xxxxx`). It resolves the
 * authed account, pulls its recent statuses, and buckets them by the day they were
 * posted:
 *
 *   GET https://<host>/api/v1/accounts/verify_credentials   → { id }
 *   GET https://<host>/api/v1/accounts/<id>/statuses?limit=40 → [ { created_at } ]
 *
 * Auth is a user access token (Bearer). Same record contract as the other API
 * plugins — a wide daily table merged into record/daily/mastodon.csv.
 */

interface Account {
  id?: string;
}
interface Status {
  /** The paging cursor (max_id). Never read, so we never asked for page 2. */
  id?: string;
  created_at?: string;
}

const PER_PAGE = 40;

export function normalizeMastodon(statuses: Status[], from: string, to: string, tz: string = recordTimeZone()): DailyTable {
  const posts = new Map<string, number>();
  for (const s of statuses) {
    const day = s.created_at ? localDay(s.created_at, tz) : "";
    if (!day || !inWindow(day, from, to)) continue;
    posts.set(day, (posts.get(day) ?? 0) + 1);
  }
  const header = ["date", "posts"];
  const rows = [...posts.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(posts.get(d) ?? 0)]);
  return { header, rows };
}

export const mastodonPlugin: ImporterPlugin = {
  id: "mastodon",
  name: "Mastodon",
  detail: "posts per day",
  live: true,
  // A partial view never lowers a fuller one: the statuses feed returns the newest ~40 and takes no date range, so a day is recomputed from whatever slice of it is still in that buffer.
  // Replacing on every sync made each day decay toward zero as the buffer slid
  // past it, and ate an imported lifetime export the moment a sync touched one of
  // its days. A shorter look is not news. See MergePolicy in record.ts.
  mergePolicy: "max",
  requiresCredential: true,
  credentialLabel: "Mastodon host:token",
  credentialPlaceholder: "mastodon.social:your-access-token",
  credentialHelp: {
    url: "https://mastodon.social/settings/applications",
    steps: [
      "On YOUR instance: Preferences → Development → New application (read scope is enough).",
      "Open the application and copy \"Your access token\".",
      "Paste it here as your.instance.host:token.",
    ],
  },
  primaryMetric: "posts",
  unit: "posts",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const [rawHost, token] = splitCredential(ctx.credential);
    const host = rawHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!host || !token) {
      throw new Error("Mastodon needs a host:token credential (e.g. mastodon.social:token).");
    }
    const auth = { Authorization: `Bearer ${token}` };
    let account: Account;
    try {
      account = (await getJson(
        `https://${host}/api/v1/accounts/verify_credentials`,
        auth,
        fetchImpl,
      )) as Account;
    } catch (e) {
      throw new Error(`Mastodon verify_credentials → ${(e as Error).message}`);
    }
    if (!account?.id) throw new Error("Mastodon verify_credentials returned no account id.");
    // Statuses are id-paged (max_id), 40 at a time, newest first. One page meant an
    // active poster kept the last ~8 days, forever: every older chunk filtered to zero
    // and the backfill walk gave up after two. Page back until we fall out of the
    // window and the history is actually reachable.
    let list: Status[];
    try {
      list = await pageAll<Status>("Mastodon statuses", async (cursor) => {
        const url = new URL(`https://${host}/api/v1/accounts/${account.id}/statuses`);
        url.searchParams.set("limit", String(PER_PAGE));
        if (cursor) url.searchParams.set("max_id", String(cursor));
        const raw = (await getJson(url.toString(), auth, fetchImpl)) as Status[];
        const batch = Array.isArray(raw) ? raw : [];
        const last = batch.at(-1);
        const past = (last?.created_at ?? "").slice(0, 10) < ctx.from;
        const more = batch.length === PER_PAGE && !past && Boolean(last?.id);
        return { items: batch, next: more ? String(last!.id) : null };
      });
    } catch (e) {
      throw new Error(`Mastodon statuses → ${(e as Error).message}`);
    }
    return { table: normalizeMastodon(list, ctx.from, ctx.to, recordTimeZone()), meta: { pulled: list.length } };
  },
};
