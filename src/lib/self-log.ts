/**
 * Daily self-ratings — the single definition of the check-in dimensions, shared
 * by the capture card, the API validator, and any label. Plain and obvious: each
 * dimension is one number from 1 to 10. No invented categories, no jargon —
 * ratings land in `record/daily/self.csv` (date + one numeric column per
 * dimension) through the same merge → rebuild path every importer uses.
 */

/** Source stem → record/daily/self.csv, and the `self` source in the daily table. */
export const SELF_SOURCE = "self";
export const SELF_MIN = 1;
export const SELF_MAX = 10;

export interface SelfDimension {
  key: string; // daily-table metric column (record/daily/self.csv header)
  label: string; // what the card shows
  hint: string; // what the ends of the scale mean
}

/** The four rated dimensions, in card + CSV column order. */
export const SELF_DIMENSIONS: SelfDimension[] = [
  { key: "mood", label: "Mood", hint: "1 low · 10 great" },
  { key: "energy", label: "Energy", hint: "1 drained · 10 charged" },
  { key: "focus", label: "Focus", hint: "1 scattered · 10 sharp" },
  { key: "sleep", label: "Sleep quality", hint: "1 awful · 10 rested" },
];

export const SELF_KEYS = SELF_DIMENSIONS.map((d) => d.key);

/** Coerce to a whole 1–10 rating, or null when it isn't one. */
export function validRating(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < SELF_MIN || n > SELF_MAX) return null;
  return n;
}

/** True for a YYYY-MM-DD calendar date. */
export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
