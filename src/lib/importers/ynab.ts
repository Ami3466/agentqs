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
 * YNAB (You Need A Budget) — what you actually spent, per day. Uses the
 * transactions endpoint on your last-used budget:
 *
 *   GET https://api.ynab.com/v1/budgets/last-used/transactions?since_date=<from>
 *
 * Auth is a Personal Access Token (bearer) — paste one from
 * app.ynab.com/settings/developer, no OAuth. Amounts are milliunits (−50000 = an
 * outflow of 50.00); a negative amount is spending, a positive one is income. The
 * transaction `date` is already the calendar day you assigned it, so it needs no
 * timezone conversion.
 */

interface YnabTxn {
  date?: string; // YYYY-MM-DD
  amount?: number; // milliunits; negative = outflow
  deleted?: boolean;
}
interface YnabResp {
  data?: { transactions?: YnabTxn[] };
}

const API = "https://api.ynab.com/v1/budgets/last-used/transactions";

export function normalizeYnab(txns: YnabTxn[], from: string, to: string): DailyTable {
  const header = ["date", "spent", "income", "transactions"];
  const spent = new Map<string, number>(); // positive dollars out
  const income = new Map<string, number>();
  const count = new Map<string, number>();
  for (const t of txns) {
    const date = (t.date ?? "").slice(0, 10);
    if (t.deleted || !date || !inWindow(date, from, to) || typeof t.amount !== "number") continue;
    count.set(date, (count.get(date) ?? 0) + 1);
    if (t.amount < 0) spent.set(date, (spent.get(date) ?? 0) + -t.amount / 1000);
    else if (t.amount > 0) income.set(date, (income.get(date) ?? 0) + t.amount / 1000);
  }
  const dates = [...new Set([...count.keys()])].sort();
  const rows = dates.map((d) => [
    d,
    spent.has(d) ? num(spent.get(d)!) : "",
    income.has(d) ? num(income.get(d)!) : "",
    String(count.get(d) ?? 0),
  ]);
  return { header, rows };
}

export const ynabPlugin: ImporterPlugin = {
  id: "ynab",
  name: "YNAB",
  detail: "money — spent & income per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "YNAB personal access token",
  credentialPlaceholder: "your YNAB PAT",
  credentialHelp: {
    url: "https://app.ynab.com/settings/developer",
    steps: [
      "Sign in to YNAB and open Account Settings → Developer Settings.",
      "Click \"New Token\", confirm your password, then copy the token and paste it here.",
    ],
  },
  envKey: "YNAB_TOKEN",
  primaryMetric: "spent",
  unit: "spent/day",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    // since_date returns every transaction on or after `from`; the window's upper
    // bound is applied client-side (inWindow), so a resume never re-lands old rows.
    url.searchParams.set("since_date", ctx.from);
    let raw: YnabResp;
    try {
      raw = (await getJson(
        url.toString(),
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      )) as YnabResp;
    } catch (e) {
      throw new Error(`YNAB transactions → ${(e as Error).message}`);
    }
    const table = normalizeYnab(raw?.data?.transactions ?? [], ctx.from, ctx.to);
    return { table, meta: { pulledDays: table.rows.length } };
  },
};
