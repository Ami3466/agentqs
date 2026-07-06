import fs from "fs";
import { configPath, dataDir } from "./paths";
import type { JournalView } from "./journal";
import type { Interval } from "./sources";
import type { Skill } from "./skills";

/**
 * On-disk config, the first thing agentqs writes. Its presence is the "has this
 * instance been set up?" signal that drives the first-run redirect.
 */
export interface AppConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  llmProvider: string; // "" | anthropic | openai | google
  llmKey: string;
  model: string;
  theme: string; // light | dark | system
  createdAt: string;
  githubToken?: string; // GitHub PAT for the commits importer (optional)
  githubSyncedAt?: string; // ISO timestamp of the last GitHub import
  journalViews?: JournalView[]; // saved Journal table layouts, per user
  sourceIntervals?: Record<string, Interval>; // per-source sync cadence (Data tab)
  sourceCreds?: Record<string, string>; // per-source API key / OAuth token (Tier-1 plugins)
  sourceSyncedAt?: Record<string, string>; // per-source last-sync ISO (Tier-1 plugins)
  customSkills?: Skill[]; // user-authored mentor personas (CLI/API/MCP add-mentor); merged with built-ins
}

/** Coerce untrusted input into a clean JournalView[] before it hits config.json.
 * Drops anything malformed so a bad POST can never corrupt the saved layouts. */
export function sanitizeJournalViews(input: unknown): JournalView[] {
  if (!Array.isArray(input)) return [];
  const out: JournalView[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const id = typeof v.id === "string" && v.id ? v.id : "";
    const name = typeof v.name === "string" ? v.name.trim() : "";
    if (!id || !name) continue;
    const columnOrder = Array.isArray(v.columnOrder)
      ? v.columnOrder.filter((s): s is string => typeof s === "string")
      : [];
    const columnVisibility: Record<string, boolean> = {};
    if (v.columnVisibility && typeof v.columnVisibility === "object") {
      for (const [k, val] of Object.entries(v.columnVisibility as Record<string, unknown>)) {
        if (typeof val === "boolean") columnVisibility[k] = val;
      }
    }
    const columnSizing: Record<string, number> = {};
    if (v.columnSizing && typeof v.columnSizing === "object") {
      for (const [k, val] of Object.entries(v.columnSizing as Record<string, unknown>)) {
        if (typeof val === "number" && Number.isFinite(val)) columnSizing[k] = val;
      }
    }
    out.push({ id, name: name.slice(0, 60), columnOrder, columnVisibility, columnSizing });
  }
  return out.slice(0, 50); // hard cap
}

export function configExists(): boolean {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

export function readConfig(): AppConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as AppConfig;
  } catch {
    return null;
  }
}

export function writeConfig(cfg: AppConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Secret used to sign sessions — env override wins, else the per-instance one. */
export function sessionSecretFor(cfg: AppConfig): string {
  return process.env.SESSION_SECRET || cfg.sessionSecret;
}

/** Safe projection for the client — no password hash, no raw key. */
export interface PublicConfig {
  username: string;
  llmProvider: string;
  hasLlmKey: string; // masked tail, or ""
  model: string;
  theme: string;
  dataDir: string;
  createdAt: string;
}

export function publicConfig(cfg: AppConfig): PublicConfig {
  const key = cfg.llmKey || "";
  return {
    username: cfg.username,
    llmProvider: cfg.llmProvider,
    hasLlmKey: key ? `••••••••${key.slice(-4)}` : "",
    model: cfg.model,
    theme: cfg.theme,
    dataDir: dataDir(),
    createdAt: cfg.createdAt,
  };
}
