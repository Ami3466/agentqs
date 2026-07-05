import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import type { DailyTable } from "../plugin";
import type { FileImporter, FileImportContext, FileImportResult } from "../file-plugin";

/**
 * Apple Health — a Tier-2 file importer. Health → your profile → "Export All
 * Health Data" produces `export.zip`; unzipped it is an `apple_health_export/`
 * folder with a single (often huge) `export.xml`. Every sample is a
 * `<Record type="…" startDate="…" value="…"/>` element. This importer streams the
 * file line by line (never loads the whole export into memory) and sums the daily
 * headline metrics:
 *
 *   date, steps, active_energy (kcal), exercise_min
 *
 * Point `--path` at `export.xml` or at the unzipped `apple_health_export` folder.
 * Deterministic given the same export + window.
 */

// HK record type → daily column it sums into.
const METRIC_BY_TYPE: Record<string, string> = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_energy",
  HKQuantityTypeIdentifierAppleExerciseTime: "exercise_min",
};
const COLUMNS = ["steps", "active_energy", "exercise_min"] as const;

/** Pull (type, day, value) from a single `<Record …>` line; null if not one. */
export function parseHealthRecord(line: string): { metric: string; day: string; value: number } | null {
  if (!line.includes("<Record ")) return null;
  const type = /\btype="([^"]+)"/.exec(line)?.[1];
  const metric = type ? METRIC_BY_TYPE[type] : undefined;
  if (!metric) return null;
  const start = /\bstartDate="([^"]+)"/.exec(line)?.[1] ?? /\bcreationDate="([^"]+)"/.exec(line)?.[1];
  const value = Number(/\bvalue="([^"]*)"/.exec(line)?.[1]);
  if (!start || !Number.isFinite(value)) return null;
  return { metric, day: start.slice(0, 10), value }; // "2024-01-01 08:00:00 -0800" → "2024-01-01"
}

/** Fold accumulated per-day sums into the wide daily table (window-bounded). */
export function healthTableFrom(
  perDay: Map<string, Record<string, number>>,
  from: string,
  to: string,
): DailyTable {
  const header = ["date", ...COLUMNS];
  const rows = [...perDay.keys()]
    .filter((day) => day >= from && day <= to)
    .sort()
    .map((day) => {
      const b = perDay.get(day)!;
      return [
        day,
        ...COLUMNS.map((c) => (b[c] != null ? String(Math.round(b[c] * 100) / 100) : "")),
      ];
    });
  return { header, rows };
}

/** Resolve the export.xml: accept the file itself or the apple_health_export dir. */
export function resolveHealthExport(input: string): string {
  const stat = fs.statSync(input);
  if (stat.isFile()) return input;
  const cand = path.join(input, "export.xml");
  if (fs.existsSync(cand)) return cand;
  throw new Error(`no export.xml under ${input} (not an Apple Health export?)`);
}

export async function readAppleHealth(
  input: string,
  from: string,
  to: string,
): Promise<FileImportResult> {
  const file = resolveHealthExport(input);
  const perDay = new Map<string, Record<string, number>>();
  let recordsScanned = 0;

  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const rec = parseHealthRecord(line);
      if (!rec) return;
      recordsScanned += 1;
      const bucket = perDay.get(rec.day) ?? {};
      bucket[rec.metric] = (bucket[rec.metric] ?? 0) + rec.value;
      perDay.set(rec.day, bucket);
    });
    rl.on("close", () => resolve());
    rl.on("error", reject);
  });

  const table = healthTableFrom(perDay, from, to);
  return { table, meta: { recordsScanned, daysWithData: table.rows.length } };
}

function appleHealthDefaultPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "apple_health_export/export.xml"),
    path.join(home, "Downloads/apple_health_export/export.xml"),
    path.join(home, "Downloads/apple_health_export"),
    "/host/apple-health/export.xml", // Docker: mount your unzipped export at /host/apple-health:ro
  ];
}

export const appleHealthImporter: FileImporter = {
  id: "apple-health",
  name: "Apple Health",
  detail: "steps, active energy, exercise minutes per day",
  connectHint: "Health app → profile → Export All Health Data. Unzip, then point --path at export.xml.",
  live: true,
  primaryMetric: "steps",
  unit: "steps",
  defaultPaths: appleHealthDefaultPaths,
  read(ctx: FileImportContext): Promise<FileImportResult> {
    return readAppleHealth(ctx.path, ctx.from, ctx.to);
  },
};
