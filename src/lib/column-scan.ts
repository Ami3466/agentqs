import crypto from "crypto";
import { readConfig, writeConfig, type AppConfig } from "./config";
import { recordDir } from "./paths";
import {
  appendInboxItem,
  appendInboxItems,
  applyDailyEdits,
  readDailyFromRecord,
  readInboxFromRecord,
  parseNumber,
  type AppliedCell,
  type DailyEdit,
} from "./record";
import { PLUGINS } from "./importers/registry";
import { FILE_IMPORTERS } from "./importers/files/registry";
import { GOOGLE_PRESET_DAILY_SOURCES } from "./google-web-scraper";
import { listAutomations } from "./automation";

/**
 * The data-quality scanner — finds broken daily columns. Three deterministic
 * checks, no LLM:
 *
 *   merge — the same metric imported twice (e.g. Chrome pulled manually AND by
 *           the automatic sync) living in two columns: same metric name in
 *           RELATED sources (source stems match once auto/manual-ish suffixes
 *           are stripped), or lookalike names whose values agree on ≥80% of ≥5
 *           shared dates. The automatically-synced side wins the merge.
 *   drop  — a dead column: every value is 0 or a blank/junk placeholder.
 *   clean — a numeric column with messy cells: numbers wrapped in units,
 *           currency or thousands separators ("72 kg", "1,234"), or junk
 *           placeholders ("n/a", "-") that should be cleared.
 *
 * Each finding becomes an inbox NOTIFICATION (kind "notification"): structuring
 * it applies the fix (every touched cell recorded for undo). Merges also save a
 * rule in config; saved rules re-apply on every import, so a manual re-import
 * can never split the column again.
 */

export interface ColumnRef {
  key: string; // `${source}.${metric}` — same key shape the Journal table uses
  source: string;
  metric: string;
}

export type QualityKind = "merge" | "drop" | "clean";

export interface QualityFinding {
  kind: QualityKind;
  id: string; // stable content hash — dedupes notifications across scans
  notificationId: string; // inbox item id this finding lands under
  key: string; // the column the fix touches (the duplicate side for merges)
  into: string | null; // merge only: the canonical column (the automatic side when known)
  cells: number; // cells the fix would touch
  reason: string;
  intoAuto: boolean; // merge only: the canonical side is a synced/automatic source
  overlap: number; // merge only: dates present in both columns
  agree: number; // merge only: 0..1 of overlap dates whose values match
  /** Lifecycle of the backing notification: "pending" (actionable), "structured"
   *  (fixed), "discarded" (user dismissed it — don't nag again). */
  notificationStatus: string;
}

export interface MergeOutcome {
  from: string;
  into: string;
  moved: number; // from-values copied onto dates the canonical column lacked
  kept: number; // conflicting dates where the canonical (auto) value won
  cleared: number; // from-cells removed with the duplicate column
  applied: AppliedCell[]; // undo trail — replay in reverse via revertEditsFromAppliedMeta
}

export interface ColumnGuardResult {
  autoMerged: MergeOutcome[]; // saved rules that re-applied on this run
  findings: QualityFinding[];
  notified: number; // NEW notifications appended (stable ids dedupe re-scans)
}

/** First dot splits — the same `source.metric` convention as the Journal table. */
export function splitColumnKey(key: string): ColumnRef {
  const dot = key.indexOf(".");
  return dot > 0
    ? { key, source: key.slice(0, dot), metric: key.slice(dot + 1) }
    : { key, source: key, metric: "" };
}

// ---- detection --------------------------------------------------------------

interface ColStats {
  ref: ColumnRef;
  values: Map<string, string>; // date → raw cell
  minDate: string;
  maxDate: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Tokens that mark an import VARIANT, not a different thing — stripping them
 *  makes `chrome_daily` / `chrome`, `google_activity_scrape` / `google_activity`
 *  share a stem, which is the "related sources" signal. */
const VARIANT_TOKENS = new Set([
  "auto",
  "daily",
  "data",
  "export",
  "import",
  "imports",
  "manual",
  "scrape",
  "sync",
  "takeout",
]);

function sourceStem(source: string): string {
  return source
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !VARIANT_TOKENS.has(t))
    .join("");
}

/** `_texts` / `_semantic` sidecars carry journal text for FTS/embeddings by design
 *  — never candidates for a merge. */
function isSidecarSource(source: string): boolean {
  return /_(texts|semantic)$/.test(source);
}

/** Placeholder cells that carry no data — clearing them loses nothing. */
const JUNK_VALUES = new Set(["", "-", "--", "n/a", "na", "n.a.", "null", "none", "nan", "unknown", "?", "missing"]);

export function isJunkValue(s: string): boolean {
  return JUNK_VALUES.has(s.trim().toLowerCase());
}

/** A number wrapped in formatting a CSV cell shouldn't carry: thousands
 *  separators, a currency prefix, or a short unit suffix ("1,234", "$59.90",
 *  "72 kg", "12%"). Deliberately strict — dates, times and free text never
 *  match, so cleaning can't corrupt a real value. */
export function looseNumber(s: string): number | null {
  const strict = parseNumber(s);
  if (strict != null) return strict;
  const m = s.trim().match(/^[$€£₪]?\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:[a-zA-Z%°µ/]{1,8}\.?)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Two cells "agree" when the trimmed text matches, or both are numbers within
 *  1 absolute or 2% relative — counting imports of the same day rarely land
 *  byte-identical. */
function cellsAgree(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na == null || nb == null) return false;
  const diff = Math.abs(na - nb);
  return diff <= 1 || diff <= 0.02 * Math.max(Math.abs(na), Math.abs(nb));
}

/** Lookalike names: equal after normalization, or one is a suffix of the other
 *  (`chrome_visits` / `visits`), on the metric alone or the source+metric
 *  composite (`browser_history.chrome_visits` / `chrome.visits`). */
function similarName(a: ColumnRef, b: ColumnRef): boolean {
  const suffix = (x: string, y: string) =>
    Math.min(x.length, y.length) >= 3 && (x.endsWith(y) || y.endsWith(x));
  const nmA = norm(a.metric);
  const nmB = norm(b.metric);
  if (nmA === nmB || suffix(nmA, nmB)) return true;
  const cpA = norm(a.source) + nmA;
  const cpB = norm(b.source) + nmB;
  return cpA === cpB || suffix(cpA, cpB);
}

/** Source ids the app syncs on its own — API plugins, local file importers,
 *  browser automations, extension scrape presets, and anything with a recorded
 *  sync stamp or an active schedule. The automatic side of a duplicate pair wins
 *  the merge so future syncs keep landing in the surviving column. */
function autoSourceIds(cfg: AppConfig | null): Set<string> {
  const ids = new Set<string>(["github", "whoop"]);
  for (const p of PLUGINS) ids.add(p.id);
  for (const f of FILE_IMPORTERS) ids.add(f.id);
  for (const id of GOOGLE_PRESET_DAILY_SOURCES) ids.add(id);
  for (const a of listAutomations(cfg)) ids.add(a.id);
  for (const id of Object.keys(cfg?.sourceSyncedAt ?? {})) ids.add(id);
  for (const [id, interval] of Object.entries(cfg?.sourceIntervals ?? {})) {
    if (interval && interval !== "off") ids.add(id);
  }
  return ids;
}

function findingId(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

export function notificationIdFor(fromKey: string, intoKey: string): string {
  return `colscan-${findingId(fromKey, intoKey)}`;
}

/** Canonical column first: auto beats manual, then the column still receiving
 *  data (later max date), then the fuller one, then lexical — deterministic. */
function pickInto(a: ColStats, b: ColStats, auto: Set<string>): [ColStats, ColStats] {
  const aAuto = auto.has(a.ref.source);
  const bAuto = auto.has(b.ref.source);
  if (aAuto !== bAuto) return aAuto ? [a, b] : [b, a];
  if (a.maxDate !== b.maxDate) return a.maxDate > b.maxDate ? [a, b] : [b, a];
  if (a.values.size !== b.values.size) return a.values.size > b.values.size ? [a, b] : [b, a];
  return a.ref.key < b.ref.key ? [a, b] : [b, a];
}

/** Every daily column with its per-date values — the input all checks share. */
function readColumns(rDir: string): Map<string, ColStats> {
  const cols = new Map<string, ColStats>();
  for (const row of readDailyFromRecord(rDir)) {
    if (isSidecarSource(row.source)) continue;
    const key = `${row.source}.${row.metric}`;
    let c = cols.get(key);
    if (!c) {
      c = {
        ref: { key, source: row.source, metric: row.metric },
        values: new Map(),
        minDate: row.date,
        maxDate: row.date,
      };
      cols.set(key, c);
    }
    c.values.set(row.date, row.valueText);
    if (row.date < c.minDate) c.minDate = row.date;
    if (row.date > c.maxDate) c.maxDate = row.date;
  }
  return cols;
}

const byKey = (x: QualityFinding, y: QualityFinding) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0);

/** merge check: duplicate / near-duplicate column pairs. */
function duplicateFindings(cols: Map<string, ColStats>, cfg: AppConfig | null): QualityFinding[] {
  const auto = autoSourceIds(cfg);
  const list = [...cols.values()];
  const ruleKeys = new Set(
    (cfg?.columnMerges ?? []).map((r) => `${r.from}\0${r.into}`),
  );
  const findings: QualityFinding[] = [];

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.ref.key === b.ref.key || !similarName(a.ref, b.ref)) continue;

      const [small, large] = a.values.size <= b.values.size ? [a, b] : [b, a];
      let overlap = 0;
      let agreeCount = 0;
      const agreeing = new Set<string>();
      for (const [date, v] of small.values) {
        const other = large.values.get(date);
        if (other === undefined) continue;
        overlap++;
        if (cellsAgree(v, other)) {
          agreeCount++;
          agreeing.add(v.trim());
        }
      }
      const agree = overlap ? agreeCount / overlap : 0;

      const sameName = norm(a.ref.metric) === norm(b.ref.metric);
      const related =
        a.ref.source !== b.ref.source && sourceStem(a.ref.source) === sourceStem(b.ref.source);
      let reason = "";
      if (sameName && related) {
        // Carry the agreement evidence in the reason — it's the user's only
        // signal for whether the merge is safe (this branch fires on the name
        // match alone, even when the shared days disagree).
        const evidence = overlap
          ? `values agree on ${agreeCount} of ${overlap} shared days`
          : "no shared days to compare";
        reason = `same metric from related sources (${a.ref.source} / ${b.ref.source}); ${evidence}`;
      } else if (overlap >= 5 && agree >= 0.8 && agreeing.size >= 2) {
        // ≥5 shared days (3 coinciding counts is chance) that aren't one constant
        // (two all-zero columns "agree" perfectly and mean nothing).
        reason = `values match on ${agreeCount} of ${overlap} shared days`;
      } else {
        continue;
      }

      const [into, from] = pickInto(a, b, auto);
      const fromKey = from.ref.key;
      const intoKey = into.ref.key;
      // Already accepted as a rule — the guard folds it silently, don't re-notify.
      if (ruleKeys.has(`${fromKey}\0${intoKey}`) || ruleKeys.has(`${intoKey}\0${fromKey}`)) continue;
      const id = findingId(fromKey, intoKey);
      findings.push({
        kind: "merge",
        id,
        notificationId: `colscan-${id}`,
        key: fromKey,
        into: intoKey,
        cells: from.values.size,
        overlap,
        agree: Math.round(agree * 100) / 100,
        intoAuto: auto.has(into.ref.source),
        reason,
        notificationStatus: "pending",
      });
    }
  }
  return findings;
}

/** drop check: a dead column — every value 0 or a blank/junk placeholder. */
function deadReason(values: Map<string, string>): string | null {
  if (values.size < 5) return null; // a short column may just be starting out
  let zeros = 0;
  for (const v of values.values()) {
    if (isJunkValue(v)) continue;
    if (looseNumber(v) === 0) zeros++;
    else return null;
  }
  return zeros ? `all ${values.size} values are 0 or blank` : `all ${values.size} values are blank/junk`;
}

/** clean check: a numeric column with messy cells. Returns each dirty cell with
 *  its cleaned value ("" = clear the junk placeholder), or null when the column
 *  is clean — or holds real text, which cleaning must never touch. */
function messyCells(values: Map<string, string>): Array<{ date: string; from: string; to: string }> | null {
  let plain = 0;
  const dirty: Array<{ date: string; from: string; to: string }> = [];
  for (const [date, v] of values) {
    if (parseNumber(v) != null) {
      plain++;
      continue;
    }
    if (isJunkValue(v)) {
      dirty.push({ date, from: v, to: "" });
      continue;
    }
    const n = looseNumber(v);
    if (n != null) {
      dirty.push({ date, from: v, to: String(n) });
      continue;
    }
    return null; // a real text cell — this is a text column, not a messy numeric one
  }
  return plain >= 3 && dirty.length ? dirty : null;
}

/** Scan the daily record for every quality issue: duplicate columns (merge),
 *  dead columns (drop), messy numeric values (clean). Pure read. */
export function scanQuality(
  rDir: string = recordDir(),
  cfg: AppConfig | null = readConfig(),
): QualityFinding[] {
  const cols = readColumns(rDir);
  const findings = duplicateFindings(cols, cfg);
  const merging = new Set(findings.map((f) => f.key));
  for (const c of cols.values()) {
    if (merging.has(c.ref.key)) continue; // the duplicate side merges away anyway
    const blank = { into: null, intoAuto: false, overlap: 0, agree: 0, notificationStatus: "pending" };
    const dead = deadReason(c.values);
    if (dead) {
      // Stable per column: a dismissed dead column stays dismissed even as more
      // zeros accumulate.
      const id = findingId("drop", c.ref.key);
      findings.push({ kind: "drop", id, notificationId: `colscan-${id}`, key: c.ref.key, cells: c.values.size, reason: dead, ...blank });
      continue;
    }
    const dirty = messyCells(c.values);
    if (dirty) {
      // Hash the dirty cells too: dismissing today's junk stays dismissed, but
      // NEW junk arriving later is a new finding.
      const id = findingId("clean", c.ref.key, ...dirty.map((d) => `${d.date}=${d.from}`));
      findings.push({
        kind: "clean",
        id,
        notificationId: `colscan-${id}`,
        key: c.ref.key,
        cells: dirty.length,
        reason: `${dirty.length} of ${c.values.size} values are messy (units, separators or junk)`,
        ...blank,
      });
    }
  }
  return findings.sort(byKey);
}

// ---- merge ------------------------------------------------------------------

/**
 * Fold the `from` column into `into`: dates only `from` holds are copied over,
 * conflicting dates keep the canonical (auto) value, then the duplicate column is
 * deleted. Every touched cell lands in `applied` (with its own source) so the
 * Log's Reject can replay it in reverse. Null when `from` no longer exists.
 * Writes through applyDailyEdits — the caller rebuilds the cache.
 */
export function applyColumnMerge(
  rDir: string,
  fromKey: string,
  intoKey: string,
): MergeOutcome | null {
  const from = splitColumnKey(fromKey);
  const into = splitColumnKey(intoKey);
  if (!from.metric || !into.metric || fromKey === intoKey) return null;
  const fromVals = new Map<string, string>();
  const intoVals = new Map<string, string>();
  for (const row of readDailyFromRecord(rDir)) {
    if (row.source === from.source && row.metric === from.metric) fromVals.set(row.date, row.valueText);
    else if (row.source === into.source && row.metric === into.metric) intoVals.set(row.date, row.valueText);
  }
  if (!fromVals.size) return null;

  const edits: DailyEdit[] = [];
  const applied: AppliedCell[] = [];
  let moved = 0;
  let kept = 0;
  const dates = [...fromVals.keys()].sort();
  for (const date of dates) {
    const v = fromVals.get(date)!;
    const cur = intoVals.get(date);
    if (cur === undefined) {
      edits.push({ op: "set", source: into.source, metric: into.metric, date, value: v });
      applied.push({ d: date, m: into.metric, p: null, v, s: into.source });
      moved++;
    } else if (!cellsAgree(cur, v)) {
      kept++; // canonical value wins the conflict; the duplicate's cell just goes
    }
  }
  edits.push({ op: "deleteColumn", source: from.source, metric: from.metric });
  for (const date of dates) {
    applied.push({ d: date, m: from.metric, p: fromVals.get(date)!, v: "", s: from.source });
  }
  applyDailyEdits(edits, { recordDir: rDir });
  return { from: fromKey, into: intoKey, moved, kept, cleared: fromVals.size, applied };
}

function columnValues(rDir: string, ref: ColumnRef): Map<string, string> {
  const vals = new Map<string, string>();
  for (const row of readDailyFromRecord(rDir)) {
    if (row.source === ref.source && row.metric === ref.metric) vals.set(row.date, row.valueText);
  }
  return vals;
}

/** Delete a dead column, every cell in the undo trail. Null when already gone. */
export function applyColumnDrop(
  rDir: string,
  key: string,
): { cleared: number; applied: AppliedCell[] } | null {
  const ref = splitColumnKey(key);
  if (!ref.metric) return null;
  const vals = columnValues(rDir, ref);
  if (!vals.size) return null;
  const applied = [...vals.entries()]
    .sort()
    .map(([d, v]) => ({ d, m: ref.metric, p: v, v: "", s: ref.source }));
  applyDailyEdits([{ op: "deleteColumn", source: ref.source, metric: ref.metric }], { recordDir: rDir });
  return { cleared: vals.size, applied };
}

/** Normalize a messy numeric column: unwrap formatted numbers, clear junk
 *  placeholders. Recomputes the dirty cells at apply time — the column may have
 *  changed since the scan. Null when already clean (or no longer numeric). */
export function applyColumnClean(
  rDir: string,
  key: string,
): { fixed: number; cleared: number; applied: AppliedCell[] } | null {
  const ref = splitColumnKey(key);
  if (!ref.metric) return null;
  const dirty = messyCells(columnValues(rDir, ref));
  if (!dirty) return null;
  const edits: DailyEdit[] = dirty.map((c) => ({
    op: "set",
    source: ref.source,
    metric: ref.metric,
    date: c.date,
    value: c.to,
  }));
  const applied = dirty.map((c) => ({ d: c.date, m: ref.metric, p: c.from, v: c.to, s: ref.source }));
  applyDailyEdits(edits, { recordDir: rDir });
  return {
    fixed: dirty.filter((c) => c.to !== "").length,
    cleared: dirty.filter((c) => c.to === "").length,
    applied,
  };
}

// ---- rules (config) ----------------------------------------------------------

/** Saved graphs and Journal table layouts keep pointing at the merged-away key —
 *  swap them to the survivor so nothing the user saved goes blank. */
function remapColumnKeyInConfig(cfg: AppConfig, fromKey: string, intoKey: string): boolean {
  let changed = false;
  const fromGraphKey = `metric:${fromKey}`;
  const intoGraphKey = `metric:${intoKey}`;
  for (const g of cfg.savedGraphs ?? []) {
    if (g.xKey === fromGraphKey) {
      g.xKey = intoGraphKey;
      changed = true;
    }
    if (g.yKey === fromGraphKey) {
      g.yKey = intoGraphKey;
      changed = true;
    }
  }
  for (const v of cfg.journalViews ?? []) {
    if (v.columnOrder.includes(fromKey)) {
      v.columnOrder = v.columnOrder.includes(intoKey)
        ? v.columnOrder.filter((k) => k !== fromKey)
        : v.columnOrder.map((k) => (k === fromKey ? intoKey : k));
      changed = true;
    }
    for (const map of [v.columnVisibility, v.columnSizing] as Record<string, boolean | number>[]) {
      if (fromKey in map) {
        if (!(intoKey in map)) map[intoKey] = map[fromKey];
        delete map[fromKey];
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Accept a merge: apply it now AND save the rule so every future import folds the
 * duplicate straight back into the canonical column ("it won't happen again").
 * Also remaps saved graphs/views. Returns a zero outcome when the duplicate
 * column is already gone (the rule still gets saved).
 */
export function acceptColumnMerge(rDir: string, fromKey: string, intoKey: string): MergeOutcome {
  const outcome =
    applyColumnMerge(rDir, fromKey, intoKey) ??
    { from: fromKey, into: intoKey, moved: 0, kept: 0, cleared: 0, applied: [] };
  const cfg = readConfig();
  if (cfg) {
    let changed = remapColumnKeyInConfig(cfg, fromKey, intoKey);
    const rules = cfg.columnMerges ?? [];
    if (!rules.some((r) => r.from === fromKey && r.into === intoKey)) {
      cfg.columnMerges = [...rules, { from: fromKey, into: intoKey, savedAt: new Date().toISOString() }];
      changed = true;
    }
    if (changed) writeConfig(cfg);
  }
  return outcome;
}

/** The `{from, into}` a notification/audit item carries, or null. */
export function columnMergeOf(meta: unknown): { from: string; into: string } | null {
  if (!meta || typeof meta !== "object") return null;
  const cm = (meta as { columnMerge?: unknown }).columnMerge;
  if (!cm || typeof cm !== "object") return null;
  const { from, into } = cm as { from?: unknown; into?: unknown };
  return typeof from === "string" && typeof into === "string" && from && into ? { from, into } : null;
}

export type QualityAction =
  | { type: "merge"; from: string; into: string }
  | { type: "drop"; key: string }
  | { type: "clean"; key: string };

function keyedMeta(meta: unknown, field: "columnDrop" | "columnClean"): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = (meta as Record<string, unknown>)[field];
  if (!m || typeof m !== "object") return null;
  const key = (m as { key?: unknown }).key;
  return typeof key === "string" && key ? key : null;
}

/** The fix a scanner notification carries — the dispatch every face (structure,
 *  scan --fix) routes through. */
export function qualityActionOf(meta: unknown): QualityAction | null {
  const cm = columnMergeOf(meta);
  if (cm) return { type: "merge", ...cm };
  const drop = keyedMeta(meta, "columnDrop");
  if (drop) return { type: "drop", key: drop };
  const clean = keyedMeta(meta, "columnClean");
  if (clean) return { type: "clean", key: clean };
  return null;
}

export interface QualityOutcome {
  summary: string; // one human line of what the fix did
  source: string;
  metric: string;
  cells: number; // cells the fix touched
  applied: AppliedCell[]; // undo trail
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** Apply a finding's fix. Merges also save their rule; every path returns the
 *  undo trail the notification's `applied` meta needs. Idempotent — an already
 *  fixed column returns a zero outcome. */
export function acceptQualityAction(rDir: string, action: QualityAction): QualityOutcome {
  if (action.type === "merge") {
    const o = acceptColumnMerge(rDir, action.from, action.into);
    const ref = splitColumnKey(action.into);
    return {
      summary: o.applied.length
        ? `Merged ${action.from} into ${action.into}: ${o.moved} value${plural(o.moved)} moved, ${o.kept} conflict${plural(o.kept)} kept from ${action.into}.`
        : `${action.from} is already gone — saved the rule so it stays merged into ${action.into}.`,
      source: ref.source,
      metric: ref.metric,
      cells: o.moved,
      applied: o.applied,
    };
  }
  const ref = splitColumnKey(action.key);
  if (action.type === "drop") {
    const o = applyColumnDrop(rDir, action.key);
    return {
      summary: o
        ? `Deleted dead column ${action.key} (${o.cleared} value${plural(o.cleared)}).`
        : `${action.key} is already gone.`,
      source: ref.source,
      metric: ref.metric,
      cells: o?.cleared ?? 0,
      applied: o?.applied ?? [],
    };
  }
  const o = applyColumnClean(rDir, action.key);
  return {
    summary: o
      ? `Cleaned ${action.key}: ${o.fixed} value${plural(o.fixed)} normalized, ${o.cleared} junk cell${plural(o.cleared)} cleared.`
      : `${action.key} is already clean.`,
    source: ref.source,
    metric: ref.metric,
    cells: o ? o.fixed + o.cleared : 0,
    applied: o?.applied ?? [],
  };
}

/** Rejecting a merge (Log → Reject) must also forget its rule, or the next import
 *  would silently redo what the user just undid. Returns true when a rule fell. */
export function dropMergeRuleFor(meta: unknown): boolean {
  const cm = columnMergeOf(meta);
  if (!cm) return false;
  const cfg = readConfig();
  const rules = cfg?.columnMerges ?? [];
  const next = rules.filter((r) => !(r.from === cm.from && r.into === cm.into));
  if (!cfg || next.length === rules.length) return false;
  cfg.columnMerges = next;
  writeConfig(cfg);
  return true;
}

/**
 * Re-apply every saved rule — the "won't happen again" half. Runs after each
 * import/sync/structure. A rule that actually moved or cleared cells leaves an
 * already-structured audit item in the log carrying the undo trail, so even the
 * silent re-merges stay inspectable and rejectable.
 */
export function applySavedMerges(rDir: string = recordDir()): MergeOutcome[] {
  const rules = readConfig()?.columnMerges ?? [];
  const out: MergeOutcome[] = [];
  for (const rule of rules) {
    const o = applyColumnMerge(rDir, rule.from, rule.into);
    if (!o || !o.applied.length) continue;
    out.push(o);
    appendInboxItem(
      {
        text: `Auto-merged ${o.from} into ${o.into} (saved column rule): ${o.moved} value${o.moved === 1 ? "" : "s"} moved, ${o.kept} conflict${o.kept === 1 ? "" : "s"} kept from ${o.into}.`,
        source: "scanner",
        kind: "notification",
        status: "structured",
        meta: {
          columnMerge: { from: o.from, into: o.into },
          via: "merge",
          source: splitColumnKey(o.into).source,
          cells: o.moved,
          structuredAt: new Date().toISOString(),
          applied: o.applied,
        },
      },
      { recordDir: rDir },
    );
  }
  return out;
}

/** Human line a finding lands under in the inbox — one line, no lecture. */
export function notificationText(f: QualityFinding): string {
  if (f.kind === "merge") {
    return `${f.key} ≈ ${f.into} — ${f.reason}. Merge keeps ${f.into}${f.intoAuto ? " (auto-synced)" : ""}.`;
  }
  if (f.kind === "drop") return `${f.key} — ${f.reason}. Fix deletes the column.`;
  return `${f.key} — ${f.reason}. Fix normalizes the numbers and clears junk cells.`;
}

/**
 * Findings already sitting in the inbox as pending notifications — the persistent
 * list every scanner surface (Journal table, Data quality tab) shows without
 * running a scan. Pure read; evidence comes from the notification meta.
 */
export function pendingFindings(rDir: string = recordDir()): QualityFinding[] {
  const out: QualityFinding[] = [];
  const num = (m: Record<string, unknown>, k: string) => {
    const v = m[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const str = (m: Record<string, unknown>, k: string, fallback: string) => {
    const v = m[k];
    return typeof v === "string" && v ? v : fallback;
  };
  for (const item of readInboxFromRecord(rDir)) {
    if (item.kind !== "notification" || item.status !== "pending") continue;
    const action = qualityActionOf(item.meta);
    if (!action) continue;
    const meta = item.meta as Record<string, Record<string, unknown>>;
    if (action.type === "merge") {
      const m = meta.columnMerge;
      out.push({
        kind: "merge",
        id: findingId(action.from, action.into),
        notificationId: item.id,
        key: action.from,
        into: action.into,
        cells: num(m, "fromCells"),
        overlap: num(m, "overlap"),
        agree: num(m, "agree"),
        intoAuto: m.intoAuto === true,
        reason: str(m, "reason", "duplicate column"),
        notificationStatus: "pending",
      });
    } else {
      const m = meta[action.type === "drop" ? "columnDrop" : "columnClean"];
      out.push({
        kind: action.type,
        id: item.id.replace(/^colscan-/, ""),
        notificationId: item.id,
        key: action.key,
        into: null,
        cells: num(m, "cells"),
        overlap: 0,
        agree: 0,
        intoAuto: false,
        reason: str(m, "reason", action.type === "drop" ? "dead column" : "messy values"),
        notificationStatus: "pending",
      });
    }
  }
  return out.sort(byKey);
}

/** The per-kind meta a finding's notification carries — full evidence, so
 *  pendingFindings can rebuild the finding without a rescan. */
function findingMeta(f: QualityFinding): Record<string, unknown> {
  if (f.kind === "merge") {
    return {
      columnMerge: {
        from: f.key,
        into: f.into,
        overlap: f.overlap,
        agree: f.agree,
        reason: f.reason,
        fromCells: f.cells,
        intoAuto: f.intoAuto,
      },
    };
  }
  const m = { key: f.key, cells: f.cells, reason: f.reason };
  return f.kind === "drop" ? { columnDrop: m } : { columnClean: m };
}

/**
 * The full guard: re-apply saved merge rules, run every quality check, and queue
 * each new finding as a pending inbox notification (stable ids — a re-scan never
 * duplicates one, and a dismissed notification stays dismissed). Runs after every
 * structure (the "AI also runs this check" hook) and behind the Scan buttons.
 * The caller rebuilds when anything changed.
 */
export function columnGuard(rDir: string = recordDir()): ColumnGuardResult {
  const autoMerged = applySavedMerges(rDir);
  const findings = scanQuality(rDir, readConfig());
  const { added } = appendInboxItems(
    findings.map((f) => ({
      id: f.notificationId,
      text: notificationText(f),
      source: "scanner",
      kind: "notification",
      meta: findingMeta(f),
    })),
    { recordDir: rDir },
  );
  if (findings.length) {
    const statuses = new Map(readInboxFromRecord(rDir).map((i) => [i.id, i.status]));
    for (const f of findings) f.notificationStatus = statuses.get(f.notificationId) ?? "pending";
  }
  return { autoMerged, findings, notified: added };
}
