import {
  getJson,
  pageAll,
  windowChunks,
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Todoist — tasks you actually finished. Uses the unified v1 API's completed
 * feed (Sync v9 was retired in 2025 and now answers 410 Gone):
 *
 *   GET https://api.todoist.com/api/v1/tasks/completed/by_completion_date
 *       ?since=<from>T00:00:00Z&until=<to>T23:59:59Z&limit=200
 *
 * Auth is an API token (bearer, from Settings → Integrations). Pages chain via
 * `next_cursor`; Todoist caps a request at ~3 months, so a longer window is asked
 * for in 90-day chunks rather than handed over whole and silently clamped.
 * Completed items are bucketed by their completion day into a per-day count.
 */

interface TodoistItem {
  completed_at?: string;
}
interface TodoistResp {
  items?: TodoistItem[];
  next_cursor?: string | null;
}

const API = "https://api.todoist.com/api/v1/tasks/completed/by_completion_date";
const PAGE_LIMIT = 200;
/** Todoist will not answer a range longer than this in one request. */
const MAX_RANGE_DAYS = 90;

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
    // Todoist REFUSES a range longer than ~3 months — this file said so in its own
    // header and then handed the API a 365-day backfill chunk regardless, so a first
    // import either 400'd outright or came back quietly clamped. Ask in mouthfuls it
    // will accept, and follow every cursor within each.
    const items: TodoistItem[] = [];
    for (const w of windowChunks(ctx.from, ctx.to, MAX_RANGE_DAYS)) {
      const batch = await pageAll<TodoistItem>(`Todoist completed (${w.from}..${w.to})`, async (cursor) => {
        const url = new URL(API);
        url.searchParams.set("since", `${w.from}T00:00:00Z`);
        url.searchParams.set("until", `${w.to}T23:59:59Z`);
        url.searchParams.set("limit", String(PAGE_LIMIT));
        if (cursor) url.searchParams.set("cursor", String(cursor));
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
        const resp = raw as TodoistResp;
        return { items: resp?.items ?? [], next: resp?.next_cursor ?? null };
      });
      items.push(...batch);
    }
    return { table: normalizeTodoist(items, ctx.from, ctx.to), meta: { pulledItems: items.length } };
  },
};
