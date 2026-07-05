/**
 * Server-only source composition (uses fs). Builds the Data-tab sources list by
 * merging a registry of known integrations with the manual sources discovered in
 * the record, then layering each source's saved interval + derived last-sync and
 * computing stale/due via the pure helpers in ./sources.
 */
import fs from "fs";
import path from "path";
import type { AppConfig } from "./config";
import { recordDir } from "./paths";
import { parseGithubCsv, resolveGithubToken } from "./importers/github";
import {
  isDue,
  isStale,
  isValidInterval,
  type Interval,
  type SourceKind,
  type SourceView,
} from "./sources";

interface Registered {
  id: string;
  name: string;
  kind: SourceKind;
  detail: string;
  csv?: string; // daily/<csv>.csv this source owns (so it isn't double-counted as manual)
  syncEndpoint?: string; // present + `live` → auto-syncable
  live: boolean; // has a working importer
}

/** Known integrations. Only GitHub is live today; the rest are placeholders that
 *  the later integration loops wire up (WHOOP, Calendar, file importers). */
const REGISTERED: Registered[] = [
  {
    id: "github",
    name: "GitHub",
    kind: "api",
    detail: "commits per day",
    csv: "github",
    syncEndpoint: "/api/import/github",
    live: true,
  },
  { id: "whoop", name: "WHOOP", kind: "api", detail: "per-minute heart rate, sleep, strain", live: false },
  { id: "gcal", name: "Google Calendar", kind: "api", detail: "meetings", live: false },
  { id: "apple-health", name: "Apple Health", kind: "manual", detail: "steps, HR, sleep, workouts", live: false },
  { id: "chrome", name: "Chrome history", kind: "manual", detail: "browsing history", live: false },
];

function intervalFor(cfg: AppConfig | null, id: string): Interval {
  const raw = cfg?.sourceIntervals?.[id];
  return isValidInterval(raw) ? raw : "off";
}

function fileMtimeISO(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function dailyStems(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "daily"))
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

/** GitHub is connected once its record file holds commits; last-sync prefers the
 *  saved API timestamp, falling back to the file mtime. It is only DUE (auto-sync)
 *  when a token is actually available to run the sync. */
function githubRow(cfg: AppConfig | null, dir: string, reg: Registered): SourceView {
  const file = path.join(dir, "daily", "github.csv");
  const days = fs.existsSync(file) ? parseGithubCsv(fs.readFileSync(file, "utf8")) : [];
  const connected = days.some((d) => d.commits > 0) || days.length > 0;
  const lastSync = cfg?.githubSyncedAt ?? fileMtimeISO(file);
  const interval = intervalFor(cfg, reg.id);
  const hasToken = Boolean(resolveGithubToken());
  return {
    id: reg.id,
    name: reg.name,
    kind: reg.kind,
    detail: reg.detail,
    connected,
    interval,
    lastSync,
    stale: false,
    due: connected && hasToken && isDue(lastSync, interval),
    syncEndpoint: reg.syncEndpoint ?? null,
  };
}

/** Compose the full sources list: registered integrations + discovered manual
 *  sources (any daily/*.csv not owned by a registered source, e.g. a dropped CSV). */
export function buildSources(cfg: AppConfig | null, dir: string = recordDir()): SourceView[] {
  const owned = new Set(REGISTERED.map((r) => r.csv).filter(Boolean) as string[]);
  const out: SourceView[] = [];

  for (const reg of REGISTERED) {
    if (reg.id === "github") {
      out.push(githubRow(cfg, dir, reg));
      continue;
    }
    // Not-yet-live integrations: shown so intervals can be set, but not connected.
    out.push({
      id: reg.id,
      name: reg.name,
      kind: reg.kind,
      detail: reg.detail,
      connected: false,
      interval: intervalFor(cfg, reg.id),
      lastSync: null,
      stale: false,
      due: false,
      syncEndpoint: null,
    });
  }

  // Discovered manual sources — structured drops / pasted exports land as
  // daily/<stem>.csv. They can't auto-sync, so an overdue one is badged stale.
  for (const stem of dailyStems(dir)) {
    if (owned.has(stem)) continue;
    const lastSync = fileMtimeISO(path.join(dir, "daily", `${stem}.csv`));
    const interval = intervalFor(cfg, stem);
    out.push({
      id: stem,
      name: stem,
      kind: "manual",
      detail: "imported daily data",
      connected: true,
      interval,
      lastSync,
      stale: isStale(lastSync, interval),
      due: false,
      syncEndpoint: null,
    });
  }

  return out;
}
