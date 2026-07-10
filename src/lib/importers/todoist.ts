import {
  getJson,
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Todoist — tasks you actually finished. Uses the Sync v9 completed feed:
 *
 *   GET https://api.todoist.com/sync/v9/completed/get_all
 *       ?since=<from>T00:00&until=<to>T23:59
 *
 * Auth is an API token (bearer, from Settings → Integrations). Completed items are
 * bucketed by their completion day into a per-day done count.
 */

interface TodoistItem {
  completed_at?: string;
}
interface TodoistResp {
  items?: TodoistItem[];
}

const API = "https://api.todoist.com/sync/v9/completed/get_all";

export function normalizeTodoist(items: TodoistItem[], from: string, to: string): DailyTable {
  const done = new Map<string, number>();
  for (const it of items) {
    const day = (it.completed_at ?? "").slice(0, 10);
    if (!day || !inWindow(day, from, to)) continue;
    done.set(day, (done.get(day) ?? 0) + 1);
  }
  const header = ["date", "completed"];
  const rows = [...done.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(done.get(d) ?? 0)]);
  return { header, rows };
}

export const todoistPlugin: ImporterPlugin = {
  id: "todoist",
  name: "Todoist",
  detail: "tasks completed per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "Todoist API token",
  credentialPlaceholder: "your Todoist API token",
  credentialHelp: {
    url: "https://app.todoist.com/app/settings/integrations/developer",
    steps: [
      "Open Todoist Settings → Integrations → Developer.",
      "Copy the API token and paste it here.",
    ],
  },
  envKey: "TODOIST_TOKEN",
  primaryMetric: "completed",
  unit: "tasks",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = new URL(API);
    url.searchParams.set("since", `${ctx.from}T00:00`);
    url.searchParams.set("until", `${ctx.to}T23:59`);
    url.searchParams.set("limit", "200");
    let raw: unknown;
    try {
      raw = await getJson(
        url.toString(),
        { Authorization: `Bearer ${ctx.credential ?? ""}`, Accept: "application/json" },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Todoist completed → ${(e as Error).message}`);
    }
    const items = (raw as TodoistResp)?.items ?? [];
    return { table: normalizeTodoist(items, ctx.from, ctx.to), meta: { pulledItems: items.length } };
  },
};
