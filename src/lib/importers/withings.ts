import {
  getJson,
  pageAll,
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
  /** `more` + `offset` = "I truncated this; ask again from here". Never read. */
  body?: { measuregrps?: MeasureGroup[]; more?: number; offset?: number };
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
  credentialHelp: {
    url: "https://developer.withings.com",
    steps: [
      "Register a (free) app in the Withings developer portal.",
      "Set its Callback URI to the Redirect URI shown here.",
      "Paste the Client ID and Client Secret into the fields here and press Authorize.",
    ],
  },
  oauth: {
    authUrl: "https://account.withings.com/oauth2_user/authorize2",
    // Withings' token endpoint is non-standard: action=requesttoken in the
    // body, and the tokens ride a {status, body} envelope (status !== 0 = error).
    tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
    scope: "user.metrics",
    tokenAuth: "body",
    tokenExtraParams: { action: "requesttoken" },
    tokenUnwrap: "withings",
  },
  envKey: "WITHINGS_TOKEN",
  primaryMetric: "weight",
  unit: "kg",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // Withings truncates a long window and says so with `more` + an `offset`. We made
    // exactly one call, so a scale reporting several groups a day silently lost the
    // OLDEST months of every chunk (groups come back newest-first) — weight history
    // full of holes that read as "I didn't weigh myself then".
    let groups: MeasureGroup[];
    try {
      groups = await pageAll<MeasureGroup>("Withings getmeas", async (cursor) => {
        const url =
          `${API}?action=getmeas&meastype=${WEIGHT_TYPE}&category=1` +
          `&startdate=${unixSec(ctx.from)}&enddate=${unixSec(ctx.to, true)}` +
          (cursor ? `&offset=${cursor}` : "");
        const raw = (await getJson(url, { Authorization: `Bearer ${ctx.credential ?? ""}` }, fetchImpl)) as MeasureResp;
        if (typeof raw.status === "number" && raw.status !== 0) {
          throw new Error(`Withings API status ${raw.status}${raw.error ? ` — ${raw.error}` : ""}`);
        }
        return { items: raw.body?.measuregrps ?? [], next: raw.body?.more ? (raw.body?.offset ?? null) : null };
      });
    } catch (e) {
      throw new Error(`Withings getmeas → ${(e as Error).message}`);
    }
    return { table: normalizeWithings(groups, ctx.from, ctx.to), meta: { groups: groups.length } };
  },
};
