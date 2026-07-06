import fs from "fs";
import path from "path";
import { readConfig, writeConfig } from "./config";
import { recordDir } from "./paths";
import { appendInboxItem, appendSession, mergeDailyCsv, rebuild } from "./record";

/**
 * Generic demo data — a throwaway sample record so a brand-new instance has
 * something to explore before any real source is connected. It is deliberately
 * NObody's data: made-up round numbers on four everyday metrics, two sample
 * memos, one sample session. The moment a real import runs, `wipeDemoOnImport`
 * clears every trace of it so it can never mingle with the user's own record.
 */

const DEMO_SOURCES = ["steps", "sleep", "focus", "mood"] as const;
const DEMO_INBOX_SOURCE = "demo";
const DEMO_SESSION_PREFIX = "demo-";

/** Deterministic pseudo-random in [0,1) from an integer seed — no real randomness,
 *  so the demo record is byte-identical every time it's seeded. */
function rnd(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Build a wide `date,<metric>` table of `days` generic rows for one metric. */
function series(metric: string, days: number, shape: (t: number, r: number) => number) {
  const rows: string[][] = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = (days - 1 - i) / (days - 1);
    rows.push([isoDaysAgo(i), String(shape(t, rnd(i + metric.length)))]);
  }
  return { header: ["date", metric], rows };
}

export function isDemoSeeded(): boolean {
  return readConfig()?.demoSeeded === true;
}

/** Seed the generic demo record and rebuild the cache. Idempotent. */
export function seedDemo(): { days: number } {
  const dir = recordDir();
  const days = 45;

  mergeDailyCsv(dir, "steps", series("steps", days, (t, r) => Math.round(6000 + r * 6000 + t * 1500)));
  mergeDailyCsv(dir, "sleep", series("sleep", days, (_t, r) => Math.round((6.2 + r * 2.3) * 10) / 10));
  mergeDailyCsv(dir, "focus", series("focus", days, (t, r) => Math.round(90 + r * 180 + t * 60)));
  mergeDailyCsv(dir, "mood", series("mood", days, (_t, r) => Math.round((2.5 + r * 2.5) * 10) / 10));

  appendInboxItem({ source: DEMO_INBOX_SOURCE, text: "Sample memo: slept badly, big deploy today - watch the focus dip." });
  appendInboxItem({ source: DEMO_INBOX_SOURCE, text: "Sample memo: long walk cleared my head after the standup." });

  appendSession({
    id: `${DEMO_SESSION_PREFIX}welcome`,
    skill: "mentor",
    title: "Sample session",
    summary: "A demo mentor session so the Journal timeline isn't empty. Connect a real source to replace all of this.",
    insights: ["Focus tracks sleep closely in this sample.", "Mood lifts on higher-step days."],
    commitments: ["Connect one real source to see your own patterns."],
  });

  const cfg = readConfig();
  if (cfg) {
    cfg.demoSeeded = true;
    writeConfig(cfg);
  }
  rebuild({ recordDir: dir });
  return { days };
}

/** Remove every trace of the demo record and rebuild. Safe to call when none exists. */
export function clearDemo(): void {
  const dir = recordDir();
  for (const src of DEMO_SOURCES) {
    const file = path.join(dir, "daily", `${src}.csv`);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  dropJsonlLines(path.join(dir, "inbox.jsonl"), (o) => o.source === DEMO_INBOX_SOURCE);
  dropJsonlLines(path.join(dir, "sessions.jsonl"), (o) => String(o.id ?? "").startsWith(DEMO_SESSION_PREFIX));

  const cfg = readConfig();
  if (cfg?.demoSeeded) {
    cfg.demoSeeded = false;
    writeConfig(cfg);
  }
  rebuild({ recordDir: dir });
}

/**
 * Call at the top of any real import: if demo data is present, wipe it first so a
 * real source never lands next to the sample rows. No-op once wiped.
 */
export function wipeDemoOnImport(): void {
  if (isDemoSeeded()) clearDemo();
}

/** Rewrite a .jsonl file dropping lines whose parsed object matches `drop`. */
function dropJsonlLines(file: string, drop: (o: Record<string, unknown>) => boolean): void {
  if (!fs.existsSync(file)) return;
  const kept: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "") continue;
    try {
      if (drop(JSON.parse(t) as Record<string, unknown>)) continue;
    } catch {
      /* keep unparseable lines */
    }
    kept.push(t);
  }
  fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
}
