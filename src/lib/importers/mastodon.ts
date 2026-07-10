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
  created_at?: string;
}

export function normalizeMastodon(statuses: Status[], from: string, to: string): DailyTable {
  const posts = new Map<string, number>();
  for (const s of statuses) {
    const day = (s.created_at ?? "").slice(0, 10);
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
    let statuses: Status[];
    try {
      statuses = (await getJson(
        `https://${host}/api/v1/accounts/${account.id}/statuses?limit=40`,
        auth,
        fetchImpl,
      )) as Status[];
    } catch (e) {
      throw new Error(`Mastodon statuses → ${(e as Error).message}`);
    }
    const list = Array.isArray(statuses) ? statuses : [];
    return { table: normalizeMastodon(list, ctx.from, ctx.to), meta: { pulled: list.length } };
  },
};
