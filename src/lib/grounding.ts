import fs from "fs";
import { openReadonly, type DB } from "./db";
import { dbPath } from "./paths";

/**
 * Grounding — the read layer the chat uses to answer from real numbers instead of
 * a horoscope. Pulls the numeric cells of the daily cache into per-metric series,
 * formats a compact DATA CONTEXT block for the model's system prompt, and (when no
 * AI key is set) computes a deterministic cross-source answer straight from the
 * numbers so a cross-source question is still answered, grounded, with no key.
 *
 * Server-only (fs + sqlite). Imported by /api/chat and the ships-when proof.
 */

export interface Point {
  date: string;
  value: number;
}

export interface MetricSeries {
  source: string;
  metric: string;
  key: string; // `${source}.${metric}`
  points: Point[]; // ascending by date
  latest: number;
  avg: number;
  min: number;
  max: number;
}

export interface Grounding {
  hasData: boolean;
  sources: string[];
  series: MetricSeries[];
}

/** A compact metric series the Chat renders as an inline sparkline under a grounded
 *  reply — the shape of a cited number over time, plus its summary stats. */
export interface SparkPayload {
  source: string;
  metric: string;
  points: Point[]; // ascending by date, tail only
  latest: number;
  avg: number;
  min: number;
  max: number;
}

const EMPTY: Grounding = { hasData: false, sources: [], series: [] };

/** Does the message look like it's asking about the user's data (so the keyless
 *  path should compute a grounded cross-source answer rather than a mentor note)?
 *  Shared by the Chat route and the channel bots so their routing can't drift. */
export function looksLikeDataQuestion(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("?")) return true;
  return /\b(why|how|what|when|which|compare|correlat|affect|impact|pattern|trend|productiv|focus|sleep|tired|commit|meeting|music|recovery|hrv|heart|listen)\b/.test(
    t,
  );
}

/** Does the message look like a *semantic recall* ("find days that felt like this",
 *  "days like this one", "when did I feel this way", "similar days")? These route to
 *  the embedding index rather than the numeric cross-source path. Shared by the Chat
 *  route and the channel bots. */
export function looksLikeRecallQuestion(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bfe(el|els|lt|eling)\s+like\b/.test(t) ||
    /\bfeels?\s+like\s+this\b/.test(t) ||
    /\b(days?|times?|moments?)\s+(that|like|when|where)\b/.test(t) ||
    /\bsimilar\s+(days?|to)\b/.test(t) ||
    /\bremind|\breminds?\s+me\b/.test(t) ||
    /\blike\s+this\b/.test(t) ||
    /\bfind\s+(days?|other)\b/.test(t) ||
    /\bwhen\s+(did|have)\s+i\s+(feel|felt|last)\b/.test(t)
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read the daily cache into numeric per-metric series (one per source.metric). */
export function readGrounding(file: string = dbPath()): Grounding {
  if (!fs.existsSync(file)) return EMPTY;
  let db: DB;
  try {
    db = openReadonly(file);
  } catch {
    return EMPTY;
  }
  try {
    const rows = db
      .prepare(
        `SELECT date, source, metric, value_num AS num
         FROM daily WHERE value_num IS NOT NULL
         ORDER BY source, metric, date`,
      )
      .all() as { date: string; source: string; metric: string; num: number }[];
    const byKey = new Map<string, MetricSeries>();
    const sources = new Set<string>();
    for (const r of rows) {
      sources.add(r.source);
      const key = `${r.source}.${r.metric}`;
      let s = byKey.get(key);
      if (!s) {
        s = { source: r.source, metric: r.metric, key, points: [], latest: 0, avg: 0, min: Infinity, max: -Infinity };
        byKey.set(key, s);
      }
      s.points.push({ date: r.date, value: r.num });
    }
    const series: MetricSeries[] = [];
    for (const s of byKey.values()) {
      if (!s.points.length) continue;
      const values = s.points.map((p) => p.value);
      s.latest = s.points[s.points.length - 1].value;
      s.avg = round(values.reduce((a, b) => a + b, 0) / values.length);
      s.min = Math.min(...values);
      s.max = Math.max(...values);
      series.push(s);
    }
    return { hasData: series.length > 0, sources: [...sources].sort(), series };
  } catch {
    return EMPTY;
  } finally {
    db.close();
  }
}

/**
 * Pick one numeric series to draw as a sparkline beside a grounded reply — the one
 * the answer actually cited. `metrics` may hold bare metric names (`sleep_hours`,
 * from the SQL tool) or `source.metric` keys (from the keyless path); `sources` are
 * the source names the reply drew on. Prefers a series matching both, then a metric,
 * then any series from a cited source. Returns null when there's nothing to show.
 */
export function buildSpark(
  g: Grounding,
  sources: string[],
  metrics: string[],
  tail = 24,
): SparkPayload | null {
  if (!g.hasData) return null;
  const srcSet = new Set(sources);
  const metSet = new Set(metrics);
  const matchesMetric = (s: MetricSeries) => metSet.has(s.metric) || metSet.has(s.key);
  const pick =
    g.series.find((s) => srcSet.has(s.source) && matchesMetric(s)) ??
    g.series.find((s) => matchesMetric(s)) ??
    g.series.find((s) => srcSet.has(s.source)) ??
    null;
  if (!pick) return null;
  const points = pick.points.slice(-tail);
  if (points.length < 2) return null; // a single dot isn't a sparkline
  return {
    source: pick.source,
    metric: pick.metric,
    points,
    latest: pick.latest,
    avg: pick.avg,
    min: pick.min,
    max: pick.max,
  };
}

/** Compact DATA CONTEXT block for the model's system prompt (numbers to cite). */
export function groundingContext(g: Grounding, opts: { maxMetrics?: number; recent?: number } = {}): string {
  if (!g.hasData) return "";
  const maxMetrics = opts.maxMetrics ?? 24;
  const recent = opts.recent ?? 8;
  const lines: string[] = [
    "DATA CONTEXT — the user's real daily record. Cite these numbers; never invent any.",
    `Sources: ${g.sources.join(", ")}`,
  ];
  for (const s of g.series.slice(0, maxMetrics)) {
    const tail = s.points
      .slice(-recent)
      .map((p) => `${p.date}=${p.value}`)
      .join(", ");
    lines.push(
      `- ${s.key}: latest ${s.latest}, avg ${s.avg}, range ${s.min}–${s.max} (recent: ${tail})`,
    );
  }
  return lines.join("\n");
}

// ---- Keyless cross-source answer -----------------------------------------

/** Loose synonyms so a natural question maps onto source / metric names. */
const SYNONYMS: Record<string, string[]> = {
  commits: ["commit", "code", "coding", "github", "ship", "shipped", "work"],
  productivity_pulse: ["productivity", "productive", "focus", "rescuetime", "focused"],
  productive_hours: ["productive", "focus", "deep work"],
  distracting_hours: ["distract", "distracted", "distraction"],
  meetings: ["meeting", "meetings", "calendar", "calls", "call"],
  meeting_hours: ["meeting", "meetings", "calendar"],
  tracks: ["music", "spotify", "listen", "listened", "songs", "song", "tracks"],
  minutes: ["music", "spotify", "listen", "listened"],
  recovery: ["recovery", "whoop", "recovered"],
  hrv: ["hrv", "variability"],
  resting_hr: ["heart", "hr", "resting", "pulse"],
  sleep: ["sleep", "slept", "rest"],
};

function scoreMetric(s: MetricSeries, q: string): number {
  const hay = q.toLowerCase();
  let score = 0;
  if (hay.includes(s.source.toLowerCase())) score += 2;
  if (hay.includes(s.metric.toLowerCase().replace(/_/g, " "))) score += 3;
  for (const syn of SYNONYMS[s.metric] ?? []) if (hay.includes(syn)) score += 2;
  return score;
}

function sharedDates(a: MetricSeries, b: MetricSeries): { date: string; av: number; bv: number }[] {
  const bMap = new Map(b.points.map((p) => [p.date, p.value]));
  const out: { date: string; av: number; bv: number }[] = [];
  for (const p of a.points) {
    if (bMap.has(p.date)) out.push({ date: p.date, av: p.value, bv: bMap.get(p.date)! });
  }
  return out;
}

/** Pick two numeric series from DIFFERENT sources: prefer ones the question names,
 *  otherwise the pair that shares the most dates (so a day-by-day line-up exists). */
export function pickCrossSourcePair(
  g: Grounding,
  question: string,
): [MetricSeries, MetricSeries] | null {
  const bySource = new Map<string, MetricSeries[]>();
  for (const s of g.series) {
    const arr = bySource.get(s.source) ?? [];
    arr.push(s);
    bySource.set(s.source, arr);
  }
  if (bySource.size < 2) return null;

  // Best-scoring metric per source for this question.
  const bestPerSource: MetricSeries[] = [];
  for (const arr of bySource.values()) {
    const ranked = [...arr].sort((x, y) => scoreMetric(y, question) - scoreMetric(x, question) || y.points.length - x.points.length);
    bestPerSource.push(ranked[0]);
  }
  bestPerSource.sort((x, y) => scoreMetric(y, question) - scoreMetric(x, question));

  const topScore = scoreMetric(bestPerSource[0], question);
  if (topScore > 0) {
    const a = bestPerSource[0];
    // Best partner from a different source, preferring shared dates then score.
    const others = bestPerSource
      .filter((s) => s.source !== a.source)
      .sort(
        (x, y) =>
          sharedDates(a, y).length - sharedDates(a, x).length ||
          scoreMetric(y, question) - scoreMetric(x, question),
      );
    if (others.length) return [a, others[0]];
  }

  // Fallback: the cross-source pair with the most overlapping dates.
  let best: [MetricSeries, MetricSeries] | null = null;
  let bestN = -1;
  const bests = bestPerSource;
  for (let i = 0; i < bests.length; i++) {
    for (let j = i + 1; j < bests.length; j++) {
      if (bests[i].source === bests[j].source) continue;
      const n = sharedDates(bests[i], bests[j]).length;
      if (n > bestN) {
        bestN = n;
        best = [bests[i], bests[j]];
      }
    }
  }
  return best;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function avg(nums: number[]): number {
  return round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

export interface GroundedAnswer {
  text: string;
  sources: string[];
  metrics: string[];
}

/**
 * A deterministic, genuinely grounded cross-source answer computed straight from
 * the daily numbers — used on the keyless path so a cross-source question still
 * gets a real answer. Lines two metrics up on their shared days and reports the
 * relationship plus the actual figures.
 */
export function groundedCrossSourceAnswer(g: Grounding, question: string): GroundedAnswer | null {
  const pair = pickCrossSourcePair(g, question);
  if (!pair) return null;
  const [a, b] = pair;
  const shared = sharedDates(a, b);
  const meta = { sources: [a.source, b.source], metrics: [a.key, b.key] };

  if (shared.length >= 3) {
    const cut = median(shared.map((d) => d.av));
    const high = shared.filter((d) => d.av >= cut);
    const low = shared.filter((d) => d.av < cut);
    const bHigh = high.length ? avg(high.map((d) => d.bv)) : null;
    const bLow = low.length ? avg(low.map((d) => d.bv)) : null;
    const example = [...shared].sort((x, y) => y.av - x.av)[0];
    const rel =
      bHigh != null && bLow != null
        ? bHigh === bLow
          ? `${b.metric} holds around ${bHigh} either way`
          : `${b.metric} runs ${bHigh} on your high-${a.metric} days vs ${bLow} on the low ones`
        : `${b.metric} averages ${b.avg}`;
    const text =
      `Across ${shared.length} days where I have both, your ${a.metric} (${a.source}) and ${b.metric} (${b.source}) line up: ${rel}. ` +
      `Overall ${a.metric} averages ${a.avg} (range ${a.min}–${a.max}); ${b.metric} averages ${b.avg}. ` +
      `Your peak ${a.metric} day was ${example.date} (${example.av}), when ${b.metric} was ${example.bv}.`;
    return { text, ...meta };
  }

  // Not enough overlap to line up day-by-day — still answer across both sources.
  const text =
    `From your record: ${a.metric} (${a.source}) averages ${a.avg}, latest ${a.latest}; ` +
    `${b.metric} (${b.source}) averages ${b.avg}, latest ${b.latest}. ` +
    `They share too few days to line up directly — sync a wider window and I'll correlate them day by day.`;
  return { text, ...meta };
}
