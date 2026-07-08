import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { parseCsv } from "../src/lib/record";
import { recordDir } from "../src/lib/paths";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const json = process.argv.includes("--json");
const checkTakeout = process.argv.includes("--check-takeout");
const production = process.argv.includes("--production");
const gapDays = Number(arg("--gap-days") ?? 30);
const browserStart = arg("--browser-start") ?? "2009-01-01";
const browserEnd = arg("--browser-end") ?? new Date().toISOString().slice(0, 10);

const sources = [
  "google_myactivity",
  "chrome",
  "google_activity",
  "google_timeline_semantic",
  "google_timeline",
  "google_fit",
  "google_calendar_takeout",
  "google_maps_places",
  "google_timeline_settings",
];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

function sourceDates(source: string): string[] {
  const file = path.join(recordDir(), "daily", `${source}.csv`);
  if (!fs.existsSync(file)) return [];
  const { rows } = parseCsv(fs.readFileSync(file, "utf8"));
  return [...new Set(rows.map((r) => (r[0] ?? "").trim()).filter(Boolean))].sort();
}

function gaps(dates: string[], minDays: number): Array<{ start: string; end: string; days: number }> {
  return dates
    .slice(1)
    .map((date, idx) => {
      const prev = dates[idx];
      return { start: addDays(prev, 1), end: addDays(date, -1), days: daysBetween(prev, date) - 1 };
    })
    .filter((g) => g.days >= minDays)
    .sort((a, b) => b.days - a.days);
}

function coverage(source: string) {
  const dates = sourceDates(source);
  return {
    source,
    first: dates[0] ?? null,
    last: dates[dates.length - 1] ?? null,
    days: dates.length,
    gaps: gaps(dates, gapDays).slice(0, 5),
  };
}

function classifyBrowserHistory(myActivity: ReturnType<typeof coverage>) {
  const mainGap = myActivity.gaps[0] ?? null;
  const coversStart = Boolean(myActivity.first && myActivity.first <= browserStart);
  const coversEnd = Boolean(myActivity.last && myActivity.last >= browserEnd);
  if (myActivity.days === 0) return "needs_takeout";
  if (mainGap && mainGap.days >= gapDays) return "imported_with_gaps";
  if (coversStart && coversEnd) return "complete_enough";
  return "imported_with_gaps";
}

function takeoutStatus(): string | null {
  if (!checkTakeout) return null;
  const res = spawnSync("npx", ["tsx", "scripts/check-google-takeout.ts", "--expect", "My Activity"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  return out.match(/^status=(.+)$/m)?.[1]?.trim() ?? (res.error ? "unavailable" : "unknown");
}

const coverages = sources.map(coverage);
const myActivity = coverages.find((c) => c.source === "google_myactivity")!;
const currentTakeoutStatus = takeoutStatus();
const status = {
  generatedAt: new Date().toISOString(),
  browserHistory: {
    source: "google_myactivity",
    status: classifyBrowserHistory(myActivity),
    takeoutStatus: currentTakeoutStatus,
    productionAcquisitionPath:
      "Data Portability API if available; otherwise guided My Activity Takeout export to connected cloud storage; local archive upload only as fallback.",
    requestedRange: { start: browserStart, end: browserEnd },
    nextOfficialAction:
      currentTakeoutStatus === "no_takeout_tab"
        ? "Open the completed My Activity export in Google Takeout, complete Google auth if required, then download/import it."
        :
      currentTakeoutStatus === "reauth_required"
        ? "Complete Google re-authentication in Chrome, then run scripts/check-google-takeout.ts --expect \"My Activity\" --download --import."
        : currentTakeoutStatus === "ready"
          ? "Run scripts/check-google-takeout.ts --expect \"My Activity\" --download --import."
          :
      myActivity.gaps[0]?.days
        ? "Complete/download the My Activity Takeout export, then run scripts/import-google-lifetime.ts."
        : "No large My Activity gap detected.",
    largestGap: myActivity.gaps[0] ?? null,
  },
  sources: coverages,
};

if (json) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(`browser_history_status=${status.browserHistory.status}`);
  if (production) console.log(`browser_history_production_path=${status.browserHistory.productionAcquisitionPath}`);
  if (status.browserHistory.takeoutStatus) console.log(`browser_history_takeout_status=${status.browserHistory.takeoutStatus}`);
  console.log(`browser_history_action=${status.browserHistory.nextOfficialAction}`);
  if (status.browserHistory.largestGap) {
    const g = status.browserHistory.largestGap;
    console.log(`browser_history_largest_gap=${g.start}..${g.end} days=${g.days}`);
  }
  console.log("\n# Sources");
  for (const c of coverages) {
    console.log(`${c.source}: ${c.first ?? "none"}..${c.last ?? "none"} days=${c.days}`);
    for (const g of c.gaps) console.log(`  gap ${g.start}..${g.end} days=${g.days}`);
  }
}
