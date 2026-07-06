export type GraphViewType = "correlation" | "timeline";
export type GraphRangePreset = "30" | "60" | "90" | "custom" | "all";

export interface SavedGraph {
  id: string;
  name: string;
  xKey: string;
  yKey: string;
  view: GraphViewType;
  range: GraphRangePreset;
  startDate?: string;
  endDate?: string;
}

function cleanKey(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 160) : "";
}

function cleanDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

export function sanitizeSavedGraphs(input: unknown): SavedGraph[] {
  if (!Array.isArray(input)) return [];
  const out: SavedGraph[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const id = cleanKey(v.id);
    const name = cleanKey(v.name);
    const xKey = cleanKey(v.xKey);
    const yKey = cleanKey(v.yKey);
    const view = v.view === "timeline" ? "timeline" : v.view === "correlation" ? "correlation" : "";
    const range =
      v.range === "30" || v.range === "60" || v.range === "90" || v.range === "custom" || v.range === "all"
        ? v.range
        : "30";
    if (!id || seen.has(id) || !name || !xKey || !view) continue;
    if (view === "correlation" && !yKey) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 80),
      xKey,
      yKey,
      view,
      range,
      startDate: range === "custom" ? cleanDate(v.startDate) : undefined,
      endDate: range === "custom" ? cleanDate(v.endDate) : undefined,
    });
  }
  return out.slice(0, 40);
}
