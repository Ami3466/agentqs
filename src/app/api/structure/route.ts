import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig } from "@/lib/config";
import { recordDir } from "@/lib/paths";
import {
  mergeDailyCsv,
  readRecord,
  rebuild,
  updateInboxItems,
  type InboxItem,
} from "@/lib/record";
import { llmComplete } from "@/lib/llm";
import {
  parseLlmCsv,
  proseExtractionSystem,
  proseExtractionUser,
  sourceName,
  structureCsv,
} from "@/lib/structure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Route = "csv" | "llm";
type Status = "structured" | "empty" | "error";

interface ItemResult {
  id: string;
  route: Route;
  status: Status;
  source?: string;
  rowsAdded?: number; // daily cells written (= long-form rows added)
  metrics?: string[];
  dates?: number;
  message?: string;
}

function filenameOf(item: InboxItem): string | undefined {
  const m = item.meta;
  if (m && typeof m === "object" && "filename" in m) {
    const f = (m as { filename?: unknown }).filename;
    if (typeof f === "string" && f.trim()) return f;
  }
  return undefined;
}

/**
 * Drain pending inbox items into the daily table. Clean CSV/TSV maps straight to
 * columns (no LLM); prose goes through the model to the same wide shape. Each
 * structured item is marked `structured` in the record and the cache is rebuilt
 * once at the end, so the new rows show up in the daily table immediately.
 *
 * Body: `{ id }` structures one pending item; `{}` / `{ all: true }` drains all.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { id?: string; all?: boolean };
  const rDir = recordDir();
  const pending = readRecord(rDir).inbox.filter((i) => i.status === "pending");

  let targets = pending;
  if (body.id) {
    targets = pending.filter((i) => i.id === body.id);
    if (targets.length === 0) {
      return NextResponse.json(
        { error: "That item isn't in the pending inbox." },
        { status: 404 },
      );
    }
  }
  if (targets.length === 0) {
    return NextResponse.json({ error: "Nothing pending to structure." }, { status: 400 });
  }

  const cfg = readConfig();
  const hasLlm = Boolean(cfg?.llmProvider && cfg?.llmKey);

  const results: ItemResult[] = [];
  const patches: Array<{ id: string; status: string; meta: unknown }> = [];
  let mutated = false;

  for (const item of targets) {
    const hint = filenameOf(item);

    // 1) Clean-CSV path — direct column map, zero LLM.
    let structured = structureCsv(item.text);
    let route: Route = "csv";
    let source: string;

    if (structured) {
      source = sourceName(hint, "import");
    } else {
      // 2) Prose path — LLM extracts the same wide shape.
      route = "llm";
      if (!hasLlm) {
        results.push({
          id: item.id,
          route,
          status: "error",
          message: "Add an AI key in Settings to structure prose notes.",
        });
        continue;
      }
      const captureDate =
        (item.ts || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      let out = "";
      try {
        out = await llmComplete({
          provider: cfg!.llmProvider,
          apiKey: cfg!.llmKey,
          model: cfg!.model,
          system: proseExtractionSystem(),
          messages: [{ role: "user", content: proseExtractionUser(item.text, captureDate) }],
          maxTokens: 700,
        });
      } catch (e) {
        results.push({
          id: item.id,
          route,
          status: "error",
          message: `Model call failed: ${(e as Error).message}`,
        });
        continue;
      }
      structured = structureCsv(parseLlmCsv(out));
      source = sourceName(hint, "notes");
      if (!structured) {
        // Nothing dated to extract — leave it pending so it can be edited/retried.
        results.push({
          id: item.id,
          route,
          status: "empty",
          message: "No dated metrics found in that note.",
        });
        continue;
      }
    }

    const merge = mergeDailyCsv(rDir, source, {
      header: structured.header,
      rows: structured.rows,
    });
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

  return NextResponse.json({
    ok: true,
    structured: results.filter((r) => r.status === "structured").length,
    results,
    pending: remaining,
    dailyRows: rebuilt?.daily ?? null,
  });
}
