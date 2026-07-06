import {
  getJson,
  num,
  unixSec,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Withings — body weight per day. Uses the Measure endpoint for weight (meastype 1)
 * over the requested window and keeps the latest reading for each day:
 *
 *   GET https://wbsapi.withings.net/measure
 *       ?action=getmeas&meastype=1&category=1&startdate=<unix>&enddate=<unix>
 *
 * Auth is an OAuth2 access token (Bearer). Withings encodes a measure as
 * value * 10^unit, so a raw {value: 815, unit: -1} is 81.5 kg. Same record contract
 * as the other API plugins — merged into record/daily/withings.csv.
 */

interface Measure {
  value?: number;
  type?: number;
  unit?: number;
}
interface MeasureGroup {
  date?: number; // unix seconds
  measures?: Measure[];
}
interface MeasureResp {
  status?: number;
  error?: string;
  body?: { measuregrps?: MeasureGroup[] };
}

const API = "https://wbsapi.withings.net/measure";
const WEIGHT_TYPE = 1;

export function normalizeWithings(groups: MeasureGroup[], from: string, to: string): DailyTable {
  // Latest weight reading wins for each day (groups arrive newest-first).
  const seen = new Set<string>();
  const byDay = new Map<string, number>();
  const ordered = [...groups].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  for (const g of ordered) {
    if (!g.date) continue;
    const day = new Date(g.date * 1000).toISOString().slice(0, 10);
    if (day < from || day > to || seen.has(day)) continue;
    const m = (g.measures ?? []).find((x) => x.type === WEIGHT_TYPE && typeof x.value === "number");
    if (!m) continue;
    seen.add(day);
    byDay.set(day, (m.value as number) * Math.pow(10, m.unit ?? 0));
  }
  const header = ["date", "weight"];
  const rows = [...byDay.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, num(byDay.get(d) as number)]);
  return { header, rows };
}

export const withingsPlugin: ImporterPlugin = {
  id: "withings",
  name: "Withings",
  detail: "body weight per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "Withings access token",
  credentialPlaceholder: "Withings OAuth access token",
  envKey: "WITHINGS_TOKEN",
  primaryMetric: "weight",
  unit: "kg",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = `${API}?action=getmeas&meastype=${WEIGHT_TYPE}&category=1&startdate=${unixSec(
      ctx.from,
    )}&enddate=${unixSec(ctx.to, true)}`;
    let raw: unknown;
    try {
      raw = await getJson(url, { Authorization: `Bearer ${ctx.credential ?? ""}` }, fetchImpl);
    } catch (e) {
      throw new Error(`Withings getmeas → ${(e as Error).message}`);
    }
    const resp = raw as MeasureResp;
    if (typeof resp.status === "number" && resp.status !== 0) {
      throw new Error(`Withings API status ${resp.status}${resp.error ? ` — ${resp.error}` : ""}`);
    }
    const groups = resp.body?.measuregrps ?? [];
    return { table: normalizeWithings(groups, ctx.from, ctx.to), meta: { groups: groups.length } };
  },
};
