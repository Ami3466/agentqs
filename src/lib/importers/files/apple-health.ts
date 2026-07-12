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

/** Unit → factor into the metric's canonical unit. Apple writes the export in
 *  the device's LOCALE units (a US phone exports distance as mi, energy can be
 *  kJ/Cal) — summing raw values would silently land wrong numbers. Unknown
 *  units fall back to 1 rather than dropping the record. */
const KM_PER: Record<string, number> = { km: 1, mi: 1.609344, m: 0.001, yd: 0.0009144, ft: 0.0003048 };
const KCAL_PER: Record<string, number> = { kcal: 1, Cal: 1, cal: 0.001, kJ: 0.239006, J: 0.000239006 };

const QUANTITY_SUM: Record<string, { metric: string; units?: Record<string, number> }> = {
  HKQuantityTypeIdentifierStepCount: { metric: "steps" },
  HKQuantityTypeIdentifierDistanceWalkingRunning: { metric: "distance_km", units: KM_PER },
  HKQuantityTypeIdentifierFlightsClimbed: { metric: "flights" },
  HKQuantityTypeIdentifierActiveEnergyBurned: { metric: "active_energy_kcal", units: KCAL_PER },
};
const QUANTITY_AVG: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "hr_avg",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_hr",
};

const HEADER = [
  "date", "steps", "distance_km", "flights", "active_energy_kcal",
  "hr_avg", "resting_hr", "asleep_min", "workouts",
];

// Precompiled per attribute — attr() runs 3-6× per line on a file of tens of
// millions of lines; compiling the regex fresh each call dominated the parse.
const ATTR_RE: Record<string, RegExp> = Object.fromEntries(
  ["type", "value", "unit", "endDate", "startDate", "sourceName"].map((name) => [
    name,
    new RegExp(`\\b${name}="([^"]*)"`),
  ]),
);

function attr(line: string, name: string): string {
  const m = line.match(ATTR_RE[name]);
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
  // [start, end] epoch-ms pairs — overlaps merge at table time so the same
  // run logged by the Watch AND a third-party app counts once
  workouts: Array<[number, number]>;
  undatedWorkouts: number; // unparseable timestamps still count, undeduped
}

function dayAgg(): DayAgg {
  return { sums: new Map(), avgs: new Map(), workouts: [], undatedWorkouts: 0 };
}

/** Count intervals after merging overlaps (two devices logging one session). */
function mergedCount(spans: Array<[number, number]>): number {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let count = 1;
  let end = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] >= end) count++;
    end = Math.max(end, sorted[i][1]);
  }
  return count;
}

class HealthRollup {
  days = new Map<string, DayAgg>();
  records = 0;
  // Import window — records outside it never touch the maps (a --days 30 run
  // must not aggregate ten years just to throw them away at table time).
  constructor(private from: string = "0001-01-01", private to: string = "9999-12-31") {}

  private day(date: string): DayAgg {
    let d = this.days.get(date);
    if (!d) {
      d = dayAgg();
      this.days.set(date, d);
    }
    return d;
  }

  private addSum(d: DayAgg, metric: string, source: string, value: number): void {
    let perSource = d.sums.get(metric);
    if (!perSource) {
      perSource = new Map<string, number>();
      d.sums.set(metric, perSource);
    }
    perSource.set(source, (perSource.get(source) ?? 0) + value);
  }

  line(raw: string): void {
    const line = raw.trimStart();
    if (line.startsWith("<Record ")) {
      // Type first: untracked types (Basal energy, audio exposure, …) dominate
      // an export — they must not pay for the other attribute scans.
      const type = attr(line, "type");
      const sum = QUANTITY_SUM[type];
      const avgMetric = sum ? undefined : QUANTITY_AVG[type];
      const sleep = !sum && !avgMetric && type === "HKCategoryTypeIdentifierSleepAnalysis";
      if (!sum && !avgMetric && !sleep) return;
      const end = attr(line, "endDate");
      const date = end.slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(date) || date < this.from || date > this.to) return;
      if (sum) {
        const v = Number(attr(line, "value"));
        if (Number.isFinite(v)) {
          this.records++;
          const factor = sum.units ? (sum.units[attr(line, "unit")] ?? 1) : 1;
          this.addSum(this.day(date), sum.metric, attr(line, "sourceName") || "unknown", v * factor);
        }
        return;
      }
      if (avgMetric) {
        const v = Number(attr(line, "value"));
        if (!Number.isFinite(v)) return;
        this.records++;
        const d = this.day(date);
        let acc = d.avgs.get(avgMetric);
        if (!acc) {
          acc = { sum: 0, n: 0 };
          d.avgs.set(avgMetric, acc);
        }
        acc.sum += v;
        acc.n++;
        return;
      }
      // Sleep: Asleep segments only — InBed/Awake are not sleep.
      if (!/Asleep/.test(attr(line, "value"))) return;
      const s = parseAppleDate(attr(line, "startDate"));
      const e = parseAppleDate(end);
      if (s == null || e == null || e <= s) return;
      this.records++;
      this.addSum(this.day(date), "asleep_min", attr(line, "sourceName") || "unknown", (e - s) / 60_000);
      return;
    }
    if (line.startsWith("<Workout ")) {
      const end = attr(line, "endDate");
      const date = end.slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(date) || date < this.from || date > this.to) return;
      this.records++;
      const s = parseAppleDate(attr(line, "startDate"));
      const e = parseAppleDate(end);
      if (s != null && e != null && e > s) this.day(date).workouts.push([s, e]);
      else this.day(date).undatedWorkouts++;
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
          mergedCount(d.workouts) + d.undatedWorkouts
            ? String(mergedCount(d.workouts) + d.undatedWorkouts)
            : "",
        ];
      });
    return { header: HEADER, rows };
  }
}

/** unzip's member argument is a GLOB — a rezipped export whose member path
 *  holds `[ ] * ?` would extract nothing without escaping (same trap the
 *  Takeout archive importer documents). */
function escGlob(s: string): string {
  return s.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
}

/** Resolve the export.xml stream behind a zip / folder / bare xml path. */
function openExportStream(file: string): { stream: Readable; done: () => void; verify: () => Promise<void> } {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    const xml = path.join(file, "export.xml");
    if (!fs.existsSync(xml)) throw new Error(`no export.xml inside ${file} — point at the Health export folder, zip, or xml.`);
    return { stream: fs.createReadStream(xml), done: () => {}, verify: async () => {} };
  }
  if (/\.zip$/i.test(file)) {
    const members = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 })
      .split(/\r?\n/)
      .filter(Boolean);
    const member = members.find((m) => /(^|\/)export\.xml$/i.test(m));
    if (!member) throw new Error(`${file} holds no export.xml — is this the Health app's export.zip?`);
    const child = spawn("unzip", ["-p", file, escGlob(member)], { stdio: ["ignore", "pipe", "ignore"] });
    // A corrupt/truncated zip makes unzip die MID-STREAM after emitting part of
    // the XML — without checking the exit code that would land a silently
    // partial lifetime history.
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject); // e.g. unzip not installed
    });
    return {
      stream: child.stdout,
      done: () => child.kill(),
      verify: async () => {
        const code = await exited;
        if (code !== 0) {
          throw new Error(`unzip exited with code ${code} reading ${file} — the export.zip looks corrupt or truncated.`);
        }
      },
    };
  }
  return { stream: fs.createReadStream(file), done: () => {}, verify: async () => {} };
}

/** Stream-parse an Apple Health export into the wide daily table. */
export async function readAppleHealth(file: string, from: string, to: string): Promise<FileImportResult> {
  const rollup = new HealthRollup(from, to);
  const { stream, done, verify } = openExportStream(file);
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) rollup.line(line);
  } finally {
    done(); // no-op after a clean drain; kills the unzip child if the loop threw
  }
  await verify();
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
