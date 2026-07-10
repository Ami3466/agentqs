import {
  inWindow,
  postJson,
  type DailyTable,
  type ImporterContext,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Notion — how much you wrote/edited in your workspace. Uses the Search endpoint,
 * sorted by last edit, and counts pages by the day they were last touched:
 *
 *   POST https://api.notion.com/v1/search
 *        { sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 }
 *
 * Auth is an internal-integration token (bearer) + the required Notion-Version
 * header. Results are bucketed by their last-edited day into a per-day
 * pages-edited count.
 */

interface NotionResult {
  last_edited_time?: string;
}
interface NotionResp {
  results?: NotionResult[];
}

const API = "https://api.notion.com/v1/search";
const VERSION = "2022-06-28";

export function normalizeNotion(results: NotionResult[], from: string, to: string): DailyTable {
  const edits = new Map<string, number>();
  for (const r of results) {
    const day = (r.last_edited_time ?? "").slice(0, 10);
    if (!day || !inWindow(day, from, to)) continue;
    edits.set(day, (edits.get(day) ?? 0) + 1);
  }
  const header = ["date", "pages_edited"];
  const rows = [...edits.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((d) => [d, String(edits.get(d) ?? 0)]);
  return { header, rows };
}

export const notionPlugin: ImporterPlugin = {
  id: "notion",
  name: "Notion",
  detail: "pages edited per day",
  live: true,
  requiresCredential: true,
  credentialLabel: "Notion integration token",
  credentialPlaceholder: "secret_… (internal integration token)",
  credentialHelp: {
    url: "https://www.notion.so/my-integrations",
    steps: [
      "Create a new internal integration in your workspace and copy its secret.",
      "Share the pages/databases you want counted with the integration (page ⋯ → Connections).",
      "Paste the secret here.",
    ],
  },
  envKey: "NOTION_TOKEN",
  primaryMetric: "pages_edited",
  unit: "pages",
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    let raw: unknown;
    try {
      raw = await postJson(
        API,
        { Authorization: `Bearer ${ctx.credential ?? ""}`, "Notion-Version": VERSION },
        { sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 },
        fetchImpl,
      );
    } catch (e) {
      throw new Error(`Notion search → ${(e as Error).message}`);
    }
    const results = (raw as NotionResp)?.results ?? [];
    return { table: normalizeNotion(results, ctx.from, ctx.to), meta: { pulledPages: results.length } };
  },
};
