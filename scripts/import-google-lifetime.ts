import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { parseCsv } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) out.push(process.argv[++i]);
  }
  return out;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const home = os.homedir();
const roots = [
  ...args("--root"),
  path.join(home, "Downloads"),
  path.join(home, "Library", "CloudStorage"),
].filter((p, idx, arr) => p && arr.indexOf(p) === idx && fs.existsSync(p));
const explicitZips = args("--zip");
const explicitTimelines = args("--timeline");
const dryRun = hasFlag("--dry-run");
const gapDaysArg = process.argv.indexOf("--gap-days");
const gapDays = gapDaysArg >= 0 && process.argv[gapDaysArg + 1] ? Number(process.argv[gapDaysArg + 1]) : 30;

function walk(root: string, maxDepth = 9): string[] {
  const out: string[] = [];
  const stack: Array<{ file: string; depth: number }> = [{ file: root, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(next.file);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      out.push(next.file);
      continue;
    }
    if (!stat.isDirectory() || next.depth >= maxDepth) continue;
    const base = path.basename(next.file);
    if (base === "node_modules" || base === ".git" || base === ".next") continue;
    let children: string[];
    try {
      children = fs.readdirSync(next.file);
    } catch {
      continue;
    }
    for (const child of children) stack.push({ file: path.join(next.file, child), depth: next.depth + 1 });
  }
  return out;
}

function uniq(files: string[]): string[] {
  return [...new Set(files.map((f) => path.resolve(f)))].sort((a, b) => a.localeCompare(b));
}

function dedupeArchiveCopies(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // Keep unreadable paths visible; the importer will report the real error.
    }
    const normalizedName = path.basename(file).toLowerCase().replace(/ \(\d+\)(?=\.zip$)/, "");
    const key = `${normalizedName}:${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function discoverZips(): string[] {
  const found = roots.flatMap((root) =>
    walk(root).filter((file) => /takeout.*\.zip$/i.test(path.basename(file))),
  );
  return dedupeArchiveCopies(uniq([...explicitZips, ...found]));
}

function discoverTimelineFiles(): string[] {
  const found = roots.flatMap((root) =>
    walk(root).filter((file) => {
      const base = path.basename(file).toLowerCase();
      return base === "location-history.json" || base === "timeline.json" || /^timeline.*\.json$/.test(base);
    }),
  );
  return uniq([...explicitTimelines, ...found]);
}

function run(label: string, cmd: string, argv: string[]): void {
  console.log(`\n# ${label}`);
  console.log([cmd, ...argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" "));
  if (dryRun) return;
  execFileSync(cmd, argv, { stdio: "inherit" });
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function coverage(source: string): { summary: string; gaps: string[] } | null {
  const file = path.join(recordDir(), "daily", `${source}.csv`);
  if (!fs.existsSync(file)) return null;
  const { rows } = parseCsv(fs.readFileSync(file, "utf8"));
  const dates = [...new Set(rows.map((r) => (r[0] ?? "").trim()).filter(Boolean))].sort();
  if (dates.length === 0) return null;
  const gaps = dates
    .slice(1)
    .map((date, idx) => {
      const prev = dates[idx];
      return { start: addDays(prev, 1), end: addDays(date, -1), missingDays: daysBetween(prev, date) - 1 };
    })
    .filter((g) => g.missingDays >= gapDays)
    .sort((a, b) => b.missingDays - a.missingDays)
    .slice(0, 5)
    .map((g) => `${g.start}..${g.end} missing_days=${g.missingDays}`);
  return {
    summary: `${source}: ${dates[0]}..${dates[dates.length - 1]} days=${dates.length}`,
    gaps,
  };
}

const zips = discoverZips();
const timelines = discoverTimelineFiles();

console.log(`roots=${roots.length ? roots.join(" | ") : "(none)"}`);
console.log(`takeout_zips=${zips.length}`);
for (const zip of zips) console.log(`  ${zip}`);
console.log(`timeline_json=${timelines.length}`);
for (const file of timelines) console.log(`  ${file}`);

if (zips.length > 0) {
  run("Import Takeout archives", "npx", [
    "tsx",
    "scripts/import-google-takeout-archive.ts",
    ...zips.flatMap((zip) => ["--zip", zip]),
  ]);
}

for (const timeline of timelines) {
  try {
    run(`Import phone Timeline ${path.basename(timeline)}`, "npx", [
      "tsx",
      "scripts/import-google-timeline.ts",
      "--path",
      timeline,
    ]);
  } catch (e) {
    console.warn(`Skipped ${timeline}: ${(e as Error).message}`);
  }
}

console.log("\n# Coverage");
for (const source of ["google_myactivity", "google_timeline_semantic", "google_timeline", "google_fit", "google_calendar_takeout", "google_maps_places", "chrome", "google_activity"]) {
  const info = coverage(source);
  if (!info) {
    console.log(`${source}: no local daily data`);
    continue;
  }
  console.log(info.summary);
  if (info.gaps.length > 0) {
    for (const gap of info.gaps) console.log(`  gap ${gap}`);
  }
}
console.log("\nFor gaps, request the narrow product export in Takeout and rerun this script after the zip lands locally.");
