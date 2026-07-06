/**
 * The Structure step, extracted so every face shares one implementation: the
 * /api/structure route, the `agentqs structure` CLI, and the MCP `structure` tool
 * all call `structurePending`. Drains pending inbox captures into the daily table
 * — clean CSV maps straight to columns (free, no LLM); prose goes through the
 * model to the same wide shape (paid, only here). Server-only (fs + provider).
 */
import { activeLlm, readConfig } from "./config";
import { recordDir } from "./paths";
import { mergeDailyCsv, readRecord, rebuild, updateInboxItems, type InboxItem } from "./record";
import { llmComplete } from "./llm";
import {
  parseLlmCsv,
  proseExtractionSystem,
  proseExtractionUser,
  sourceName,
  structureCsv,
} from "./structure";

export type StructureRoute = "csv" | "llm";
export type StructureStatus = "structured" | "empty" | "error";

export interface StructureItemResult {
  id: string;
  route: StructureRoute;
  status: StructureStatus;
  source?: string;
  rowsAdded?: number;
  metrics?: string[];
  dates?: number;
  message?: string;
}

export interface StructureRunResult {
  ok: boolean;
  structured: number;
  results: StructureItemResult[];
  pending: number;
  dailyRows: number | null;
  error?: string;
}

function filenameOf(item: InboxItem): string | undefined {
  const m = item.meta;
  if (m && typeof m === "object" && "filename" in m) {
    const f = (m as { filename?: unknown }).filename;
    if (typeof f === "string" && f.trim()) return f;
  }
  return undefined;
}

/** Drain pending inbox items into daily rows. `{id}` structures one; `{}` drains all. */
export async function structurePending(opts: { id?: string; all?: boolean } = {}): Promise<StructureRunResult> {
  const rDir = recordDir();
  const pending = readRecord(rDir).inbox.filter((i) => i.status === "pending");

  let targets = pending;
  if (opts.id) targets = pending.filter((i) => i.id === opts.id);
  if (targets.length === 0) {
    return {
      ok: false,
      structured: 0,
      results: [],
      pending: pending.length,
      dailyRows: null,
      error: opts.id ? "That item isn't in the pending inbox." : "Nothing pending to structure.",
    };
  }

  const cfg = readConfig();
  const llm = activeLlm(cfg);
  const hasLlm = Boolean(llm);

  const results: StructureItemResult[] = [];
  const patches: Array<{ id: string; status: string; meta: unknown }> = [];
  let mutated = false;

  for (const item of targets) {
    const hint = filenameOf(item);
    let structured = structureCsv(item.text);
    let route: StructureRoute = "csv";
    let source: string;

    if (structured) {
      source = sourceName(hint, "import");
    } else {
      route = "llm";
      if (!hasLlm) {
        results.push({ id: item.id, route, status: "error", message: "Add an AI key to structure prose notes." });
        continue;
      }
      const captureDate = (item.ts || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      let out = "";
      try {
        out = await llmComplete({
          llm: llm!,
          system: proseExtractionSystem(),
          messages: [{ role: "user", content: proseExtractionUser(item.text, captureDate) }],
          maxTokens: 700,
        });
      } catch (e) {
        results.push({ id: item.id, route, status: "error", message: `Model call failed: ${(e as Error).message}` });
        continue;
      }
      structured = structureCsv(parseLlmCsv(out));
      source = sourceName(hint, "notes");
      if (!structured) {
        results.push({ id: item.id, route, status: "empty", message: "No dated metrics found in that note." });
        continue;
      }
    }

    const merge = mergeDailyCsv(rDir, source, { header: structured.header, rows: structured.rows });
    mutated = true;
    patches.push({
      id: item.id,
      status: "structured",
      meta: {
        ...(item.meta && typeof item.meta === "object" ? item.meta : {}),
        structuredAt: new Date().toISOString(),
        via: route,
        source,
        cells: merge.cells,
        metrics: merge.metrics,
      },
    });
    results.push({
      id: item.id,
      route,
      status: "structured",
      source,
      rowsAdded: merge.cells,
      metrics: merge.metrics,
      dates: merge.dates.length,
    });
  }

  if (patches.length) updateInboxItems(patches, { recordDir: rDir });
  const rebuilt = mutated ? rebuild({ recordDir: rDir }) : null;
  const remaining = readRecord(rDir).inbox.filter((i) => i.status === "pending").length;

  return {
    ok: true,
    structured: results.filter((r) => r.status === "structured").length,
    results,
    pending: remaining,
    dailyRows: rebuilt?.daily ?? null,
  };
}
