/**
 * Browser-automation import types — pure and browser-safe (NO fs), so the Data-tab
 * client (the setup wizard + the automated-imports row) and the server store both
 * import the same shapes.
 *
 * An "automation" is how agentqs imports a source that has NO ready API: you point
 * it at a site, hand it your login, record the click-path to your data once
 * (Playwright drives a real browser), then schedule how often it replays. The
 * recorded steps + a scheduled interval = a repeatable, headless import that lands
 * in your daily table like any other source.
 */

/** One replayable browser action. `value` may reference {{username}}/{{password}}/
 *  {{token}} — those are interpolated from the recipe's stored credentials at run
 *  time, so the secret never lives inside the step list. */
export type AutomationStepType =
  | "goto" // value = URL to navigate to
  | "fill" // selector + value (text; supports {{...}} placeholders)
  | "click" // selector
  | "waitForSelector" // selector (wait until it appears)
  | "press" // value = key (e.g. "Enter"); optional selector to focus first
  | "extractTable"; // selector of the <table> to scrape into daily rows (first row = header)

export interface AutomationStep {
  type: AutomationStepType;
  selector?: string;
  value?: string;
}

export type AutomationCredType = "userpass" | "token" | "none";

/** The saved recipe (no secrets — those live in AutomationCreds, kept apart so the
 *  recipe stays safe to display / export). Scheduling lives in the shared
 *  `sourceIntervals[id]` like every other source, so one cron machinery drives all. */
export interface AutomationRecipe {
  id: string; // slug → record/daily/<id>.csv
  name: string; // display name
  url: string; // start URL (the first goto)
  credType: AutomationCredType;
  steps: AutomationStep[];
  createdAt: string;
  lastRun?: string | null; // ISO of the last replay attempt
  lastStatus?: "ok" | "error" | null;
  lastError?: string | null;
  lastRows?: number | null; // cells written on the last successful run
}

/** Secrets for a recipe — stored separately from the recipe (config.automationCreds). */
export interface AutomationCreds {
  username?: string;
  password?: string;
  token?: string;
}

/** Redacted recipe for the client: booleans instead of raw secrets. */
export interface PublicAutomation extends AutomationRecipe {
  hasUsername: boolean;
  hasPassword: boolean;
  hasToken: boolean;
}

/** Ids agentqs already owns — an automation can't shadow a built-in source. */
export const RESERVED_SOURCE_IDS = [
  "github",
  "rescuetime",
  "gcal",
  "spotify",
  "whoop",
  "chrome",
  "iphone",
  "apple-health",
  "import",
  "drop",
];

/** Slugify a name into a safe source id (a-z0-9-, deduped dashes). */
export function slugifyId(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** A sensible starter recipe for the wizard, keyed off the credential style. The
 *  user tweaks selectors to match their site; the shape is always: log in →
 *  navigate → wait for the data → scrape the table. */
export function templateSteps(credType: AutomationCredType): AutomationStep[] {
  if (credType === "userpass") {
    return [
      { type: "fill", selector: "input[type=email], input[name=username]", value: "{{username}}" },
      { type: "fill", selector: "input[type=password]", value: "{{password}}" },
      { type: "click", selector: "button[type=submit]" },
      { type: "waitForSelector", selector: "table" },
      { type: "extractTable", selector: "table" },
    ];
  }
  return [
    { type: "waitForSelector", selector: "table" },
    { type: "extractTable", selector: "table" },
  ];
}

/** Replace {{username}}/{{password}}/{{token}} in a step value with the creds. */
export function interpolateCreds(value: string | undefined, creds: AutomationCreds | undefined): string {
  if (!value) return "";
  return value
    .replace(/\{\{\s*username\s*\}\}/g, creds?.username ?? "")
    .replace(/\{\{\s*password\s*\}\}/g, creds?.password ?? "")
    .replace(/\{\{\s*token\s*\}\}/g, creds?.token ?? "");
}
