import { parseCsv } from "./record";

/**
 * The Structure step: turn a raw inbox capture into wide daily rows.
 *
 *   clean CSV/TSV  → direct column map (no LLM, deterministic, free)
 *   prose note     → LLM extracts the same wide shape (paid, only here)
 *
 * Both paths converge on `structureCsv`, which normalizes a tabular text into
 * a `date`-first wide table with ISO dates. If a text isn't tabular-with-dates,
 * `structureCsv` returns null and the caller sends it to the LLM prose path.
 * The wide result is merged into `record/daily/<source>.csv` by `mergeDailyCsv`.
 */

export interface Structured {
  header: string[]; // ["date", ...metrics]
  rows: string[][]; // aligned to header, dates normalized to ISO
  metrics: string[];
  dates: string[]; // distinct, ascending
  cells: number; // non-empty metric cells (= daily rows this produces)
  // The accounting: what the parse LOST. Callers must surface these — a
  // "structured" file that silently shed rows is how a record rots.
  skippedRows: number; // rows whose date cell didn't parse — NOT merged
  skippedSamples: string[]; // up to 3 raw date cells from skipped rows
  droppedColumns: number; // empty-header columns that held data — NOT merged
}

// Header names that unambiguously mark the date column.
const DATE_HEADERS = new Set([
  "date",
  "day",
  "ds",
  "time",
  "datetime",
  "timestamp",
  "when",
]);

const DELIMS = [",", "\t", ";", "|"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Coerce a cell to ISO `YYYY-MM-DD`, or null when it isn't a recognizable date. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); // ISO (optionally with time)
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s); // YYYY/MM/DD
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US M/D/YYYY
  if (m) return `${m[3]}-${pad2(+m[1])}-${pad2(+m[2])}`;
  return null;
}

export function isDateish(s: string): boolean {
  return normalizeDate(s) !== null;
}

/** Pick the delimiter that splits the header line into the most fields. */
function detectDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMS) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** A filesystem-safe, lowercase record source stem, or "" when nothing usable. */
export function slugSource(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "") // drop a file extension
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** Source name for a capture: slug of a filename hint, else the given fallback. */
export function sourceName(hint: string | undefined, fallback: string): string {
  return (hint ? slugSource(hint) : "") || fallback;
}

/**
 * Read `text` as a clean tabular CSV/TSV with a detectable date column and return
 * a normalized wide table (date first, ISO dates, metric columns kept verbatim).
 * Returns null when the text isn't tabular-with-dates — the signal to fall back
 * to the LLM prose path.
 */
export function structureCsv(text: string): Structured | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const delim = detectDelimiter(firstLine);
  const { header, rows } = parseCsv(trimmed, delim);
  if (header.length < 2 || rows.length < 1) return null;

  // Date column: a known header name, else a column that is mostly date-ish.
  let dateCol = header.findIndex((h) => DATE_HEADERS.has(h.trim().toLowerCase()));
  if (dateCol < 0) {
    for (let c = 0; c < header.length; c++) {
      let hit = 0;
      let seen = 0;
      for (const r of rows) {
        const v = (r[c] ?? "").trim();
        if (v === "") continue;
        seen++;
        if (isDateish(v)) hit++;
      }
      if (seen > 0 && hit / seen >= 0.6) {
        dateCol = c;
        break;
      }
    }
  }
  if (dateCol < 0) return null;

  // Metric columns = everything but the date column, non-empty header only.
  const metricIdx = header
    .map((_, i) => i)
    .filter((i) => i !== dateCol && header[i].trim() !== "");
  const metrics = metricIdx.map((i) => header[i].trim());
  if (metrics.length === 0) return null;

  // An empty-header column only counts as a LOSS if some row holds data there
  // (a trailing comma makes a harmless phantom column). Rows can also be WIDER
  // than the header — those overflow cells have no column at all and are lost
  // the same way.
  const maxRowLen = rows.reduce((n, r) => Math.max(n, r.length), 0);
  let droppedColumns = header
    .map((_, i) => i)
    .filter((i) => i !== dateCol && header[i].trim() === "")
    .filter((i) => rows.some((r) => (r[i] ?? "").trim() !== "")).length;
  for (let i = header.length; i < maxRowLen; i++) {
    if (rows.some((r) => (r[i] ?? "").trim() !== "")) droppedColumns++;
  }

  const outRows: string[][] = [];
  const dateSet = new Set<string>();
  const skippedSamples: string[] = [];
  let skippedRows = 0;
  let cells = 0;
  for (const r of rows) {
    const raw = (r[dateCol] ?? "").trim();
    const date = normalizeDate(raw);
    if (!date) {
      // A row without a parseable date carries data only if any metric cell
      // is non-empty — a blank spacer line is not a loss.
      if (metricIdx.some((i) => (r[i] ?? "").trim() !== "")) {
        skippedRows++;
        if (skippedSamples.length < 3) skippedSamples.push(raw || "(empty date)");
      }
      continue;
    }
    const row = [date];
    for (const i of metricIdx) {
      const v = (r[i] ?? "").trim();
      row.push(v);
      if (v !== "") cells++;
    }
    outRows.push(row);
    dateSet.add(date);
  }
  if (outRows.length === 0 || cells === 0) return null;

  return {
    header: ["date", ...metrics],
    rows: outRows,
    metrics,
    dates: [...dateSet].sort(),
    cells,
    skippedRows,
    skippedSamples,
    droppedColumns,
  };
}

// ---- Prose path (LLM) -----------------------------------------------------

/** System prompt: make the model behave as a strict CSV-extraction function. */
export function proseExtractionSystem(): string {
  return [
    "You are a data-extraction function inside agentqs, a personal life record.",
    "Convert a raw personal note into a tidy daily CSV.",
    "Rules:",
    "- Output ONLY CSV. No prose, no explanation, no markdown code fence.",
    "- The first column header is exactly `date`, with ISO values `YYYY-MM-DD`.",
    "- Every other column is one metric in snake_case; prefer numeric values.",
    "- One row per date. Only include facts explicitly stated in the note.",
    "- If the note gives no date, use the capture date provided.",
    "- If there is nothing worth structuring, output exactly one line: date",
  ].join("\n");
}

export function proseExtractionUser(text: string, captureDate: string): string {
  return `Capture date: ${captureDate}\n\nNote:\n${text}`;
}

/** Strip a ```csv … ``` fence the model may add, leaving raw CSV text. */
export function parseLlmCsv(out: string): string {
  const s = out.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(s);
  return fence ? fence[1].trim() : s;
}
