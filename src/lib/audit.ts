import fs from "fs";
import { dbPath } from "./paths";
import { openReadonly } from "./db";

/**
 * The index audit: a DETERMINISTIC evidence packet for an AI review pass.
 *
 * Code computes the suspicious facts — impossible dates, one-day sources,
 * coverage holes, dead-quiet sources, outlier values — cheaply and
 * reproducibly, with zero AI. A reviewing agent (CLI/MCP) then JUDGES each
 * finding and files the fixes through the existing machinery (merge rules,
 * journal edits, re-imports, notifications), every one revertible. AI proposes,
 * deterministic code disposes — this module is the evidence side.
 *
 * Read-only: never touches the record or queues anything itself.
 */

export interface AuditFinding {
  kind: "impossible-date" | "single-day-source" | "coverage-gap" | "stale-source" | "outlier-values";
  source: string;
  metric?: string;
  detail: string;
  evidence: string[]; // dates / cells backing the claim, capped
}

export interface AuditReport {
  sources: number;
  findings: AuditFinding[];
  counts: Record<AuditFinding["kind"], number>;
}

const GAP_DAYS = 45; // a hole this long in an otherwise steady source is worth a look
const STALE_DAYS = 45; // a steady source silent this long may be a dead import
const EVIDENCE_CAP = 5;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function auditIndex(): AuditReport {
  const findings: AuditFinding[] = [];
  const file = dbPath();
  if (!fs.existsSync(file)) {
    return { sources: 0, findings, counts: countBy(findings) };
  }
  const db = openReadonly(file);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

    // ---- impossible dates: before personal-data plausibility or far future --
    const weird = db
      .prepare(
        "SELECT source, date, COUNT(*) n FROM daily WHERE date < '1990-01-01' OR date > ? GROUP BY source, date ORDER BY source, date",
      )
      .all(horizon) as Array<{ source: string; date: string; n: number }>;
    const weirdBySource = new Map<string, string[]>();
    for (const w of weird) {
      const list = weirdBySource.get(w.source) ?? [];
      list.push(`${w.date} (${w.n} cells)`);
      weirdBySource.set(w.source, list);
    }
    for (const [source, dates] of weirdBySource) {
      findings.push({
        kind: "impossible-date",
        source,
        detail: `${dates.length} date(s) before 1990 or more than ~13 months ahead — epoch bugs, typos, or far-future calendar entries`,
        evidence: dates.slice(0, EVIDENCE_CAP),
      });
    }

    // ---- per-source shape: one-day sources, holes, gone-quiet ---------------
    // Clamped to the plausible window: one epoch/far-future typo (flagged
    // above) must not fabricate a giant gap or mask a dead source behind a
    // future MAX(date).
    const sources = db
      .prepare(
        "SELECT source, COUNT(DISTINCT date) days, MIN(date) first, MAX(date) last FROM daily WHERE date >= '1990-01-01' AND date <= ? GROUP BY source",
      )
      .all(today) as Array<{ source: string; days: number; first: string; last: string }>;
    const dateStmt = db.prepare(
      "SELECT DISTINCT date FROM daily WHERE source = ? AND date >= '1990-01-01' AND date <= ? ORDER BY date",
    );
    for (const s of sources) {
      if (s.days <= 2 && daysBetween(s.last, today) > 90) {
        findings.push({
          kind: "single-day-source",
          source: s.source,
          detail: `only ${s.days} day(s) of data and nothing for ${daysBetween(s.last, today)} days — a partial import, or the source's export was truncated`,
          evidence: [s.first === s.last ? s.first : `${s.first} → ${s.last}`],
        });
        continue;
      }
      if (s.days >= 30 && daysBetween(s.first, s.last) >= 90) {
        const dates = (dateStmt.all(s.source, today) as Array<{ date: string }>).map((r) => r.date);
        const gaps: string[] = [];
        for (let i = 1; i < dates.length; i++) {
          const gap = daysBetween(dates[i - 1], dates[i]);
          if (gap >= GAP_DAYS) gaps.push(`${dates[i - 1]} → ${dates[i]} (${gap}d)`);
        }
        if (gaps.length) {
          findings.push({
            kind: "coverage-gap",
            source: s.source,
            detail: `${gaps.length} hole(s) of ${GAP_DAYS}+ days in an otherwise steady source — real quiet, or an import that failed silently?`,
            evidence: gaps.slice(0, EVIDENCE_CAP),
          });
        }
        if (daysBetween(s.last, today) >= STALE_DAYS) {
          findings.push({
            kind: "stale-source",
            source: s.source,
            detail: `steady for ${s.days} days but silent since ${s.last} — check the pipeline row: schedule dead, credential expired, or source retired?`,
            evidence: [s.last],
          });
        }
      }
    }

    // ---- outlier values: a numeric metric with cells wildly off its median --
    const stats = db
      .prepare(
        `SELECT source, metric, COUNT(value_num) n FROM daily
         WHERE value_num IS NOT NULL GROUP BY source, metric HAVING n >= 20`,
      )
      .all() as Array<{ source: string; metric: string; n: number }>;
    const valStmt = db.prepare(
      "SELECT date, value_num v FROM daily WHERE source = ? AND metric = ? AND value_num IS NOT NULL ORDER BY value_num",
    );
    for (const m of stats) {
      const rows = valStmt.all(m.source, m.metric) as Array<{ date: string; v: number }>;
      const mid = rows.length / 2;
      const median = rows.length % 2 ? rows[Math.floor(mid)].v : (rows[mid - 1].v + rows[mid].v) / 2;
      if (median <= 0) continue; // counts-at-zero metrics false-alarm on any spike
      const wild = rows.filter((r) => r.v > median * 50);
      if (wild.length && wild.length <= rows.length / 10) {
        findings.push({
          kind: "outlier-values",
          source: m.source,
          metric: m.metric,
          detail: `${wild.length} value(s) over 50× the median (${median}) — unit mix-up, junk placeholder, or a multi-day rollup on one date`,
          evidence: wild.slice(-EVIDENCE_CAP).map((r) => `${r.date}: ${r.v}`),
        });
      }
    }

    return { sources: sources.length, findings, counts: countBy(findings) };
  } finally {
    db.close();
  }
}

function countBy(findings: AuditFinding[]): Record<AuditFinding["kind"], number> {
  const counts = {
    "impossible-date": 0,
    "single-day-source": 0,
    "coverage-gap": 0,
    "stale-source": 0,
    "outlier-values": 0,
  } as Record<AuditFinding["kind"], number>;
  for (const f of findings) counts[f.kind]++;
  return counts;
}
