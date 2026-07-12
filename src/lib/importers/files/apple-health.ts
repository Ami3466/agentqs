import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import type { Readable } from "stream";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * Apple Health — a Tier-2 file importer for the iPhone's own export
 * (Health app → profile picture → Export All Health Data → export.zip).
 * Accepts the zip, the extracted `apple_health_export/` folder, or a bare
 * `export.xml`, and STREAMS it line by line — a lifetime export runs to
 * hundreds of MB and must never be read into one string.
 *
 * Lands in `health_daily` with the SAME metric names the record already uses,
 * so a fresh export backfills the existing partial history in place:
 *
 *   date, steps, distance_km, flights, active_energy_kcal, hr_avg,
 *   resting_hr, asleep_min, workouts
 *
 * Device dedup: an iPhone and a Watch both count steps — summing across
 * devices double-counts. Cumulative metrics aggregate per (day, sourceName)
 * and the day keeps its BEST device (max); averages pool every sample.
 * Days are the export's own wall-clock dates (the leading `YYYY-MM-DD` of
 * each timestamp — Apple writes them in the device's timezone).
 */

const QUANTITY_SUM: Record<string, { metric: string; scale?: number }> = {
  HKQuantityTypeIdentifierStepCount: { metric: "steps" },
  HKQuantityTypeIdentifierDistanceWalkingRunning: { metric: "distance_km" },
  HKQuantityTypeIdentifierFlightsClimbed: { metric: "flights" },
  HKQuantityTypeIdentifierActiveEnergyBurned: { metric: "active_energy_kcal" },
};
const QUANTITY_AVG: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "hr_avg",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_hr",
};

const HEADER = [
  "date", "steps", "distance_km", "flights", "active_energy_kcal",
  "hr_avg", "resting_hr", "asleep_min", "workouts",
];

function attr(line: string, name: string): string {
  const m = line.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : "";
}

/** "2024-05-15 22:30:00 +0300" → epoch ms (null when it doesn't parse). */
function parseAppleDate(s: string): number | null {
  const m = s.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(t) ? t : null;
}

interface DayAgg {
  // cumulative metrics: per-source sums, best source wins the day
  sums: Map<string, Map<string, number>>; // metric → sourceName → sum
  // averages: pooled samples
  avgs: Map<string, { sum: number; n: number }>; // metric → accumulator
  workouts: number;
}

function dayAgg(): DayAgg {
  return { sums: new Map(), avgs: new Map(), workouts: 0 };
}

class HealthRollup {
  days = new Map<string, DayAgg>();
  records = 0;

  private day(date: string): DayAgg {
    const d = this.days.get(date) ?? dayAgg();
    this.days.set(date, d);
    return d;
  }

  private addSum(date: string, metric: string, source: string, value: number): void {
    const perSource = this.day(date).sums.get(metric) ?? new Map<string, number>();
    perSource.set(source, (perSource.get(source) ?? 0) + value);
    this.day(date).sums.set(metric, perSource);
  }

  line(raw: string): void {
    const line = raw.trimStart();
    if (line.startsWith("<Record ")) {
      const type = attr(line, "type");
      const end = attr(line, "endDate");
      const date = end.slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) return;
      const source = attr(line, "sourceName") || "unknown";
      const sum = QUANTITY_SUM[type];
      if (sum) {
        const v = Number(attr(line, "value"));
        if (Number.isFinite(v)) {
          this.records++;
          this.addSum(date, sum.metric, source, v * (sum.scale ?? 1));
        }
        return;
      }
      const avgMetric = QUANTITY_AVG[type];
      if (avgMetric) {
        const v = Number(attr(line, "value"));
        if (!Number.isFinite(v)) return;
        this.records++;
        const acc = this.day(date).avgs.get(avgMetric) ?? { sum: 0, n: 0 };
        acc.sum += v;
        acc.n++;
        this.day(date).avgs.set(avgMetric, acc);
        return;
      }
      if (type === "HKCategoryTypeIdentifierSleepAnalysis") {
        // Asleep segments only — InBed/Awake are not sleep.
        if (!/Asleep/.test(attr(line, "value"))) return;
        const s = parseAppleDate(attr(line, "startDate"));
        const e = parseAppleDate(end);
        if (s == null || e == null || e <= s) return;
        this.records++;
        this.addSum(date, "asleep_min", source, (e - s) / 60_000);
      }
      return;
    }
    if (line.startsWith("<Workout ")) {
      const date = attr(line, "endDate").slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) return;
      this.records++;
      this.day(date).workouts++;
    }
  }

  table(from: string, to: string): DailyTable {
    const rows = [...this.days.keys()]
      .filter((d) => d >= from && d <= to)
      .sort()
      .map((date) => {
        const d = this.days.get(date)!;
        const best = (metric: string, round: (n: number) => string): string => {
          const perSource = d.sums.get(metric);
          if (!perSource) return "";
          return round(Math.max(...perSource.values()));
        };
        const avg = (metric: string): string => {
          const a = d.avgs.get(metric);
          return a && a.n ? String(Math.round(a.sum / a.n)) : "";
        };
        return [
          date,
          best("steps", (n) => String(Math.round(n))),
          best("distance_km", (n) => String(Math.round(n * 100) / 100)),
          best("flights", (n) => String(Math.round(n))),
          best("active_energy_kcal", (n) => String(Math.round(n))),
          avg("hr_avg"),
          avg("resting_hr"),
          best("asleep_min", (n) => String(Math.round(n))),
          d.workouts ? String(d.workouts) : "",
        ];
      });
    return { header: HEADER, rows };
  }
}

/** Resolve the export.xml stream behind a zip / folder / bare xml path. */
function openExportStream(file: string): { stream: Readable; done: () => void } {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const xml = path.join(file, "export.xml");
    if (!fs.existsSync(xml)) throw new Error(`no export.xml inside ${file} — point at the Health export folder, zip, or xml.`);
    return { stream: fs.createReadStream(xml), done: () => {} };
  }
  if (/\.zip$/i.test(file)) {
    const members = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 })
      .split(/\r?\n/)
      .filter(Boolean);
    const member = members.find((m) => /(^|\/)export\.xml$/i.test(m));
    if (!member) throw new Error(`${file} holds no export.xml — is this the Health app's export.zip?`);
    const child = spawn("unzip", ["-p", file, member], { stdio: ["ignore", "pipe", "ignore"] });
    return { stream: child.stdout, done: () => child.kill() };
  }
  return { stream: fs.createReadStream(file), done: () => {} };
}

/** Stream-parse an Apple Health export into the wide daily table. */
export async function readAppleHealth(file: string, from: string, to: string): Promise<FileImportResult> {
  const rollup = new HealthRollup();
  const { stream, done } = openExportStream(file);
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) rollup.line(line);
  } finally {
    done();
  }
  if (rollup.records === 0) {
    throw new Error("no Health records found — expected <Record>/<Workout> lines from the Health app's export.xml.");
  }
  const table = rollup.table(from, to);
  return {
    table,
    meta: { recordsScanned: rollup.records, daysWithData: table.rows.length },
  };
}

function appleHealthDefaultPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Downloads/export.zip"),
    path.join(home, "Downloads/apple_health_export"),
    path.join(home, "Downloads/apple_health_export/export.xml"),
  ];
}

export const appleHealthImporter: FileImporter = {
  id: "health_daily",
  name: "Apple Health",
  detail: "Health app export (export.zip / export.xml) · steps, distance, sleep, HR, workouts",
  live: true,
  primaryMetric: "steps",
  unit: "steps",
  fullHistoryDefault: true,
  defaultPaths: appleHealthDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readAppleHealth(ctx.path, ctx.from, ctx.to);
  },
};
