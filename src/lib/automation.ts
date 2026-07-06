/**
 * Automation store (server-only) — CRUD for browser-automation import recipes,
 * persisted in config. Recipes live in `config.automations`; their secrets live
 * apart in `config.automationCreds` (never merged into the recipe, so the recipe is
 * safe to list / show). Scheduling stays in `config.sourceIntervals[id]` so the same
 * cron machinery that drives every other source drives these too.
 *
 * This module owns the record; the Playwright replay lives in ./automation-run and
 * the four faces (CLI / API / MCP / GUI) all reach it through ./cli-core.
 */
import { readConfig, writeConfig, type AppConfig } from "./config";
import {
  RESERVED_SOURCE_IDS,
  slugifyId,
  type AutomationCreds,
  type AutomationRecipe,
  type AutomationStep,
  type AutomationStepType,
  type AutomationCredType,
  type PublicAutomation,
} from "./automation-types";

const STEP_TYPES: AutomationStepType[] = [
  "goto",
  "fill",
  "click",
  "waitForSelector",
  "press",
  "extractTable",
];
const CRED_TYPES: AutomationCredType[] = ["userpass", "token", "none"];

export function listAutomations(cfg: AppConfig | null = readConfig()): AutomationRecipe[] {
  return cfg?.automations ?? [];
}

export function getAutomation(id: string, cfg: AppConfig | null = readConfig()): AutomationRecipe | undefined {
  return listAutomations(cfg).find((a) => a.id === id);
}

export function isAutomation(id: string, cfg: AppConfig | null = readConfig()): boolean {
  return Boolean(getAutomation(id, cfg));
}

export function getCreds(id: string, cfg: AppConfig | null = readConfig()): AutomationCreds | undefined {
  return cfg?.automationCreds?.[id];
}

/** Redacted view for the client — booleans instead of raw secrets. */
export function publicAutomation(a: AutomationRecipe, creds?: AutomationCreds): PublicAutomation {
  return {
    ...a,
    hasUsername: Boolean(creds?.username),
    hasPassword: Boolean(creds?.password),
    hasToken: Boolean(creds?.token),
  };
}

export function listPublicAutomations(cfg: AppConfig | null = readConfig()): PublicAutomation[] {
  return listAutomations(cfg).map((a) => publicAutomation(a, getCreds(a.id, cfg)));
}

// ---- validation -----------------------------------------------------------

function cleanSteps(input: unknown): AutomationStep[] {
  if (!Array.isArray(input)) return [];
  const out: AutomationStep[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = r.type as AutomationStepType;
    if (!STEP_TYPES.includes(type)) continue;
    const step: AutomationStep = { type };
    if (typeof r.selector === "string" && r.selector.trim()) step.selector = r.selector.trim();
    if (typeof r.value === "string") step.value = r.value;
    out.push(step);
  }
  return out.slice(0, 40);
}

export interface SaveAutomationInput {
  id?: string;
  name: string;
  url: string;
  credType?: AutomationCredType;
  steps?: AutomationStep[];
  username?: string;
  password?: string;
  token?: string;
}

/** Create or update a recipe. On create, the id is the slug of the name (or an
 *  explicit id) and must not shadow a built-in source. Credentials, when supplied,
 *  are written to the separate secret store; omitted creds are left untouched. */
export function saveAutomation(input: SaveAutomationInput): PublicAutomation {
  const cfg = requireConfig();
  const name = (input.name ?? "").trim();
  if (name.length < 2) throw new Error("Give the automation a name (2+ chars).");
  const url = (input.url ?? "").trim();
  if (!/^(https?|file):\/\//i.test(url)) throw new Error("Enter a full start URL (https://…).");

  const existingId = input.id?.trim();
  let id = existingId || slugifyId(name);
  if (!id) throw new Error("Could not derive an id from the name.");

  const recipes = [...(cfg.automations ?? [])];
  if (!existingId) {
    // Creating by name: never silently overwrite a same-named recipe — a second
    // "Garmin" is a second ACCOUNT, so suffix to a free id (garmin-2, garmin-3…).
    const base = id;
    let n = 2;
    while (recipes.some((a) => a.id === id) || RESERVED_SOURCE_IDS.includes(id)) {
      id = `${base}-${n++}`;
    }
  }
  const idx = recipes.findIndex((a) => a.id === id);
  if (idx < 0 && RESERVED_SOURCE_IDS.includes(id)) {
    throw new Error(`"${id}" is a built-in source id. Pick another name.`);
  }

  const credType: AutomationCredType = CRED_TYPES.includes(input.credType as AutomationCredType)
    ? (input.credType as AutomationCredType)
    : "none";
  const steps = cleanSteps(input.steps);

  const prev = idx >= 0 ? recipes[idx] : null;
  const recipe: AutomationRecipe = {
    id,
    name,
    url,
    credType,
    steps,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    lastRun: prev?.lastRun ?? null,
    lastStatus: prev?.lastStatus ?? null,
    lastError: prev?.lastError ?? null,
    lastRows: prev?.lastRows ?? null,
  };
  if (idx >= 0) recipes[idx] = recipe;
  else recipes.push(recipe);
  cfg.automations = recipes;

  // Merge credentials into the separate secret store (only overwrite what's given).
  const creds: AutomationCreds = { ...(cfg.automationCreds?.[id] ?? {}) };
  if (typeof input.username === "string") creds.username = input.username;
  if (typeof input.password === "string" && input.password) creds.password = input.password;
  if (typeof input.token === "string" && input.token) creds.token = input.token;
  cfg.automationCreds = { ...(cfg.automationCreds ?? {}), [id]: creds };

  writeConfig(cfg);
  return publicAutomation(recipe, creds);
}

/** Set a recipe's credentials without touching its steps. */
export function setAutomationCreds(id: string, creds: AutomationCreds): PublicAutomation {
  const cfg = requireConfig();
  const recipe = getAutomation(id, cfg);
  if (!recipe) throw new Error(`No automation "${id}".`);
  const merged: AutomationCreds = { ...(cfg.automationCreds?.[id] ?? {}), ...creds };
  cfg.automationCreds = { ...(cfg.automationCreds ?? {}), [id]: merged };
  writeConfig(cfg);
  return publicAutomation(recipe, merged);
}

/** Persist the outcome of a replay (called by the runner). Best-effort. */
export function recordRun(
  id: string,
  outcome: { status: "ok" | "error"; error?: string | null; rows?: number | null; at: string },
): void {
  const cfg = readConfig();
  if (!cfg?.automations) return;
  const idx = cfg.automations.findIndex((a) => a.id === id);
  if (idx < 0) return;
  cfg.automations[idx] = {
    ...cfg.automations[idx],
    lastRun: outcome.at,
    lastStatus: outcome.status,
    lastError: outcome.error ?? null,
    lastRows: outcome.status === "ok" ? outcome.rows ?? cfg.automations[idx].lastRows ?? 0 : cfg.automations[idx].lastRows ?? null,
  };
  if (outcome.status === "ok") {
    cfg.sourceSyncedAt = { ...(cfg.sourceSyncedAt ?? {}), [id]: outcome.at };
  }
  try {
    writeConfig(cfg);
  } catch {
    /* non-fatal — the record already holds the data */
  }
}

/** Delete a recipe: drop it from config + its secrets + its schedule. The daily
 *  file + rebuild are the caller's job (cli-core.disconnectSource handles both). */
export function removeAutomation(id: string): boolean {
  const cfg = requireConfig();
  const recipes = cfg.automations ?? [];
  if (!recipes.some((a) => a.id === id)) return false;
  cfg.automations = recipes.filter((a) => a.id !== id);
  if (cfg.automationCreds) delete cfg.automationCreds[id];
  if (cfg.sourceIntervals) delete cfg.sourceIntervals[id];
  if (cfg.sourceSyncedAt) delete cfg.sourceSyncedAt[id];
  writeConfig(cfg);
  return true;
}

function requireConfig(): AppConfig {
  const cfg = readConfig();
  if (!cfg) throw new Error("agentqs isn't set up yet. Open the app once, or POST /api/setup.");
  return cfg;
}
