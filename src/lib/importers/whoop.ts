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
 * WHOOP — the per-minute differentiator (recovery, HRV, resting HR, strain). This
 * is a STUB adapter: the normalize → merge → rebuild pipeline is real and fixture-
 * provable, but WHOOP's OAuth 2 flow isn't configurable in a single run (it needs
 * an interactive redirect + refresh loop), so the Data tab marks it not-live until
 * that lands. The public API shape it reads:
 *
 *   GET https://api.prod.whoop.com/developer/v2/recovery  → { records: [...] }
 *
 * Each record is bucketed by its day into recovery %, HRV, and resting HR — the
 * daily summary. (Per-minute heart rate rides the app connection, a later loop.)
 */

interface WhoopRecord {
  created_at?: string;
  updated_at?: string;
  score?: {
    recovery_score?: number;
    resting_heart_rate?: number;
    hrv_rmssd_milli?: number;
  };
}
interface WhoopList {
  records?: WhoopRecord[];
}

const API = "https://api.prod.whoop.com/developer/v2/recovery";

export function normalizeWhoop(records: WhoopRecord[], from: string, to: string): DailyTable {
  const header = ["date", "recovery", "hrv", "resting_hr"];
  const rows: string[][] = [];
  for (const r of records) {
    const day = (r.created_at ?? r.updated_at ?? "").slice(0, 10);
    if (!day || !inWindow(day, from, to)) continue;
    const s = r.score ?? {};
    rows.push([
      day,
      s.recovery_score != null ? num(s.recovery_score) : "",
      s.hrv_rmssd_milli != null ? num(s.hrv_rmssd_milli) : "",
      s.resting_heart_rate != null ? num(s.resting_heart_rate) : "",
    ]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { header, rows };
}

export const whoopPlugin: ImporterPlugin = {
  id: "whoop",
  name: "WHOOP",
  detail: "recovery, HRV, resting HR (OAuth — coming soon)",
  live: false, // stub: OAuth not configurable in-run
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "WHOOP OAuth access token",
  envKey: "WHOOP_TOKEN",
  primaryMetric: "recovery",
  unit: "avg recovery",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    let raw: unknown;
    try {
      raw = await getJson(
        API,
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`WHOOP recovery → ${(e as Error).message}`);
    }
    const records = (raw as WhoopList)?.records ?? [];
    return { table: normalizeWhoop(records, ctx.from, ctx.to), meta: { pulledRecords: records.length } };
  },
};
