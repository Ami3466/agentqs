/**
 * cli-core — the one brain behind every non-GUI face of agentqs.
 *
 * The `agentqs` CLI (bin/agentqs-cli.ts) and the MCP server (bin/mcp.ts) both call
 * ONLY these functions; the Next app's API routes call the same underlying lib.
 * So "import a file, connect a source, schedule a sync, run a sync, add a mentor,
 * rebuild, query, chat" behave identically from the terminal, from Claude Code
 * (MCP), from `curl` (JSON API), and from the GUI. Server-only (fs + sqlite).
 *
 * Every function returns a plain JSON-able object — the CLI prints it, the MCP
 * tool wraps it in a text block, and nothing here talks to a terminal directly.
 */
import fs from "fs";
import path from "path";
import { activeLlm, effectiveProviders, readConfig, writeConfig, type AppConfig } from "./config";
import { dbPath, recordDir } from "./paths";
import { openReadonly } from "./db";
import {
  appendInboxItem,
  mergeDailyCsv,
  rebuild,
  readRecord,
  recordHash,
  updateInboxItems,
} from "./record";
import { readJournal } from "./journal";
import { buildSources } from "./source-registry";
import { isValidInterval, type Interval } from "./sources";
import { importGithub, resolveGithubToken } from "./importers/github";
import { importWhoop, whoopFixtureFetch, whoopHrDir, type WhoopCreds } from "./importers/whoop";
import { importPlugin, resolveCredential, windowDays, type FetchLike } from "./importers/plugin";
import { pluginById, PLUGINS } from "./importers/registry";
import { importFile, resolveFilePath } from "./importers/file-plugin";
import { FILE_IMPORTERS, fileImporterById } from "./importers/files/registry";
import { structureCsv, sourceName } from "./structure";
import { structurePending } from "./structure-run";
import {
  isAutomation,
  listPublicAutomations,
  removeAutomation,
  saveAutomation,
  setAutomationCreds,
  type SaveAutomationInput,
} from "./automation";
import { runAutomation, type AutomationRunResult } from "./automation-run";
import type { AutomationCreds, PublicAutomation } from "./automation-types";
import { composeReply, type ComposedReply } from "./reply";
import { listSkills, removeSkill, upsertSkill, isBuiltinSkill, type UpsertSkillInput } from "./skills-store";
import { isProvider } from "./models";
import {
  importPhotos,
  photosStatus as readPhotosStatus,
  findSimilarImages,
  photoContext as readPhotoContext,
  type ImportResult,
  type PhotosStatus,
  type ImageHit,
  type PhotoContext,
} from "./photos";
import type { Skill } from "./skills";
import type { LlmMessage } from "./llm";

// ---- chat / query ---------------------------------------------------------

/** One-shot grounded reply through the same funnel the GUI + channels use. */
export async function chat(opts: {
  message: string;
  skill?: string | null;
  history?: LlmMessage[];
}): Promise<ComposedReply> {
  return composeReply({
    message: opts.message,
    channel: "cli",
    skill: opts.skill ?? null,
    history: opts.history,
  });
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
}

/** Read-only SQL over the rebuilt cache (daily / raw_inbox / sessions / search).
 *  SELECT-only — the query path never mutates the derived store. */
export function query(sql: string, limit = 200): QueryResult {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT / WITH queries are allowed.");
  }
  const file = dbPath();
  if (!fs.existsSync(file)) throw new Error("No cache yet — run `agentqs rebuild` first.");
  const db = openReadonly(file);
  try {
    const capped = /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT ${limit}`;
    const rows = db.prepare(capped).all() as Record<string, unknown>[];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, count: rows.length };
  } finally {
    db.close();
  }
}

// ---- journal --------------------------------------------------------------

export function journal(opts: { limit?: number; source?: string } = {}) {
  const data = readJournal();
  const metrics = opts.source
    ? data.metrics.filter((m) => m.source === opts.source)
    : data.metrics;
  const days = opts.limit && opts.limit > 0 ? data.days.slice(0, opts.limit) : data.days;
  return {
    metrics,
    days,
    totalDays: data.totalDays,
    totalCells: data.totalCells,
    sources: [...new Set(data.metrics.map((m) => m.source))].sort(),
  };
}

// ---- sources: list / connect / interval / sync ----------------------------

export function sources() {
  return buildSources(readConfig());
}

/** Save an API source's credential (Tier-1 plugin). This is "connect a source". */
export function connectSource(id: string, credential: string): { id: string; saved: boolean } {
  const plugin = pluginById(id);
  if (!plugin && id !== "github") {
    throw new Error(`Unknown API source "${id}". Try: github, ${PLUGINS.map((p) => p.id).join(", ")}`);
  }
  if (!credential || !credential.trim()) throw new Error("Pass a credential to connect.");
  const cfg = requireConfig();
  if (id === "github") {
    cfg.githubToken = credential.trim();
  } else {
    cfg.sourceCreds = { ...(cfg.sourceCreds ?? {}), [id]: credential.trim() };
  }
  writeConfig(cfg);
  return { id, saved: true };
}

/** Connect WHOOP via the unofficial app login — stores email + password (config
 *  0600, never committed); tokens are minted + rotated on the first sync. Two
 *  fields, so it's separate from the single-credential connectSource. */
export function whoopConnect(email: string, password: string): { email: string; saved: boolean } {
  if (!email?.trim() || !password?.trim()) {
    throw new Error("WHOOP needs both an email and a password.");
  }
  const cfg = requireConfig();
  cfg.whoopCreds = { ...(cfg.whoopCreds ?? {}), email: email.trim(), password: password.trim() };
  writeConfig(cfg);
  return { email: email.trim(), saved: true };
}

/** Set a source's sync cadence — this is "set up an automated import". `off`,
 *  `hourly`, `daily`, `weekly`. API sources auto-sync when due; manual sources
 *  badge stale when overdue. */
export function setInterval(id: string, interval: string): { id: string; interval: Interval } {
  if (!isValidInterval(interval)) {
    throw new Error(`Invalid interval "${interval}". Use: off, hourly, daily, weekly.`);
  }
  const cfg = requireConfig();
  cfg.sourceIntervals = { ...(cfg.sourceIntervals ?? {}), [id]: interval };
  writeConfig(cfg);
  return { id, interval };
}

/** Remove an automated import: drop the source's daily/<id>.csv, forget its
 *  credential + sync time + schedule, and rebuild. The source falls back to the
 *  Connections catalog (not connected). This is the "remove" the Data tab exposes. */
export function disconnectSource(id: string): { id: string; removed: boolean; dailyRows: number } {
  const automation = isAutomation(id);
  const known =
    automation ||
    id === "github" ||
    id === "whoop" ||
    Boolean(pluginById(id)) ||
    Boolean(fileImporterById(id));
  if (!known) {
    throw new Error(
      `Unknown source "${id}". Try: github, ${[...PLUGINS.map((p) => p.id), ...FILE_IMPORTERS.map((f) => f.id)].join(", ")}`,
    );
  }
  const rDir = recordDir();
  try {
    fs.rmSync(path.join(rDir, "daily", `${id}.csv`), { force: true });
  } catch {
    /* non-fatal — nothing to remove */
  }
  // Automations carry their own record + secrets — removeAutomation clears them.
  if (automation) {
    removeAutomation(id);
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    return { id, removed: true, dailyRows };
  }
  const cfg = requireConfig();
  if (id === "github") {
    delete cfg.githubToken;
    delete cfg.githubSyncedAt;
  } else if (id === "whoop") {
    delete cfg.whoopCreds;
    if (cfg.sourceSyncedAt) delete cfg.sourceSyncedAt.whoop;
    try {
      fs.rmSync(whoopHrDir(rDir), { recursive: true, force: true }); // per-minute HR files
    } catch {
      /* non-fatal */
    }
  } else {
    if (cfg.sourceCreds) delete cfg.sourceCreds[id];
    if (cfg.sourceSyncedAt) delete cfg.sourceSyncedAt[id];
  }
  if (cfg.sourceIntervals) delete cfg.sourceIntervals[id];
  writeConfig(cfg);
  const dailyRows = rebuild({ recordDir: rDir }).daily;
  return { id, removed: true, dailyRows };
}

// ---- automations (browser-driven imports for sources with no API) ---------

/** Every configured automation recipe (redacted — secrets shown as booleans). */
export function automations(): PublicAutomation[] {
  return listPublicAutomations(readConfig());
}

/** Create or update an automation recipe (site + creds + recorded steps). */
export function automationSave(input: SaveAutomationInput): PublicAutomation {
  return saveAutomation(input);
}

/** Set an automation's credentials without touching its steps. */
export function automationCreds(id: string, creds: AutomationCreds): PublicAutomation {
  return setAutomationCreds(id, creds);
}

/** Replay an automation now: drive the browser, scrape, land in the record. This
 *  is both the "record it once" trial run and the scheduled/on-open cron path. */
export async function automationRun(opts: { id: string; headed?: boolean }): Promise<AutomationRunResult> {
  return runAutomation(opts.id, { headed: opts.headed });
}

/** Remove an automation (drops its recipe, secrets, data, and schedule). */
export function automationRemove(id: string): { id: string; removed: boolean; dailyRows: number } {
  if (!isAutomation(id)) throw new Error(`No automation "${id}".`);
  return disconnectSource(id);
}

export interface SyncResult {
  id: string;
  name: string;
  from: string;
  to: string;
  days: number;
  metrics: string[];
  cells: number;
  dailyRows: number;
  syncedAt: string;
}

/** Run one API source now: fetch → merge → rebuild, persisting the sync time.
 *  `fixture` (a JSON file) drives it offline for GitHub-style ships-when tests. */
export async function syncSource(opts: {
  id: string;
  credential?: string;
  days?: number;
  fixture?: string;
}): Promise<SyncResult> {
  const rDir = recordDir();
  const win = windowDays(opts.days && opts.days > 0 ? opts.days : 90);
  const cfg = readConfig();
  const now = new Date().toISOString();

  if (opts.id === "github") {
    const token = resolveGithubToken(opts.credential);
    const fetchImpl = opts.fixture ? fixtureFetch(opts.fixture) : undefined;
    if (!token && !fetchImpl) throw new Error("GitHub needs a token — pass --credential or set GITHUB_TOKEN.");
    const s = await importGithub({ token, from: win.from, to: win.to, recordDir: rDir, fetchImpl });
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    persistSync("github", opts.credential, now);
    return {
      id: "github", name: "GitHub", from: win.from, to: win.to,
      days: s.days.filter((d) => d.commits > 0).length,
      metrics: ["commits"], cells: s.days.length, dailyRows, syncedAt: now,
    };
  }

  if (opts.id === "whoop") {
    let fetchImpl: FetchLike | undefined;
    let creds: WhoopCreds | undefined = cfg?.whoopCreds;
    if (opts.fixture) {
      const data = JSON.parse(fs.readFileSync(opts.fixture, "utf8"));
      fetchImpl = whoopFixtureFetch(data);
      if (!creds?.email) creds = { email: "fixture@whoop", password: "x" };
    }
    if (!fetchImpl && !(creds?.email && (creds.password || creds.refreshToken))) {
      throw new Error("WHOOP needs email + password — run 'agentqs whoop connect <email> <password>'.");
    }
    const s = await importWhoop({ creds: creds!, from: win.from, to: win.to, recordDir: rDir, fetchImpl });
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    const c2 = readConfig();
    if (c2) {
      c2.whoopCreds = s.creds;
      c2.sourceSyncedAt = { ...(c2.sourceSyncedAt ?? {}), whoop: now };
      writeConfig(c2);
    }
    return {
      id: "whoop", name: "WHOOP", from: win.from, to: win.to,
      days: s.daysWithData, metrics: s.metrics, cells: s.cells, dailyRows, syncedAt: now,
    };
  }

  const plugin = pluginById(opts.id);
  if (!plugin) {
    throw new Error(`Unknown API source "${opts.id}". Try: github, whoop, ${PLUGINS.map((p) => p.id).join(", ")}`);
  }
  const credential = resolveCredential(plugin, opts.credential, cfg);
  const fetchImpl = opts.fixture ? fixtureFetch(opts.fixture) : undefined;
  if (plugin.requiresCredential && !credential && !fetchImpl) {
    throw new Error(`${plugin.name} needs a ${plugin.credentialLabel}. Pass --credential or run 'agentqs source connect ${plugin.id} <cred>'.`);
  }
  const summary = await importPlugin(plugin, { credential, from: win.from, to: win.to, fetchImpl }, rDir);
  const dailyRows = rebuild({ recordDir: rDir }).daily;
  persistSync(plugin.id, opts.credential, now);
  return {
    id: plugin.id, name: plugin.name, from: summary.from, to: summary.to,
    days: summary.daysWithData, metrics: summary.metrics, cells: summary.cells,
    dailyRows, syncedAt: now,
  };
}

/** Sync every live, connected API source that has a credential (used by `sync` with
 *  no --source). Skips sources with no credential rather than erroring. */
export async function syncAll(days?: number): Promise<{ synced: SyncResult[]; skipped: { id: string; reason: string }[] }> {
  const synced: SyncResult[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const cfg = readConfig();
  const candidates = ["github", "whoop", ...PLUGINS.filter((p) => p.live).map((p) => p.id)];
  for (const id of candidates) {
    const hasCred =
      id === "github"
        ? Boolean(resolveGithubToken())
        : id === "whoop"
          ? Boolean(cfg?.whoopCreds?.email && (cfg.whoopCreds.password || cfg.whoopCreds.refreshToken))
          : Boolean(resolveCredential(pluginById(id)!, undefined, cfg));
    if (!hasCred) {
      skipped.push({ id, reason: "no credential" });
      continue;
    }
    try {
      synced.push(await syncSource({ id, days }));
    } catch (e) {
      skipped.push({ id, reason: (e as Error).message });
    }
  }
  return { synced, skipped };
}

// ---- file sources (Tier-2, local disk) ------------------------------------

/** Import a Tier-2 local file source (Chrome history, iPhone backup). */
export async function syncFileSource(opts: {
  id: string;
  path?: string;
  days?: number;
}): Promise<SyncResult> {
  const importer = fileImporterById(opts.id);
  if (!importer) {
    throw new Error(`Unknown file source "${opts.id}". Try: ${FILE_IMPORTERS.map((f) => f.id).join(", ")}`);
  }
  const filePath = resolveFilePath(importer, opts.path);
  if (!filePath) {
    throw new Error(
      `${importer.name}: no file found. Pass --path, or probe defaults:\n  ${importer.defaultPaths().join("\n  ")}`,
    );
  }
  const rDir = recordDir();
  const win = windowDays(opts.days && opts.days > 0 ? opts.days : 90);
  const summary = await importFile(importer, { path: filePath, from: win.from, to: win.to }, rDir);
  const dailyRows = rebuild({ recordDir: rDir }).daily;
  persistSync(importer.id, undefined, new Date().toISOString());
  return {
    id: importer.id, name: importer.name, from: summary.from, to: summary.to,
    days: summary.daysWithData, metrics: summary.metrics, cells: summary.cells,
    dailyRows, syncedAt: new Date().toISOString(),
  };
}

// ---- import a raw file (the drag-and-drop escape hatch) --------------------

export interface ImportRawResult {
  inboxId: string;
  bytes: number;
  structured: boolean;
  source?: string;
  metrics?: string[];
  cells?: number;
  dailyRows?: number;
  pending: number;
  note: string;
}

/**
 * Import an arbitrary file into the record. It always lands raw in the inbox
 * (free, no LLM). A clean CSV/TSV is structured straight into the daily table
 * (deterministic column map); prose is left pending for the Structure step
 * (`agentqs structure`, which pays the LLM only then). This is the universal
 * escape hatch — the agent can absorb any source.
 */
export function importRaw(opts: { file?: string; text?: string; name?: string }): ImportRawResult {
  let text = opts.text;
  let hint = opts.name;
  if (opts.file) {
    text = fs.readFileSync(opts.file, "utf8");
    hint = hint ?? path.basename(opts.file);
  }
  if (text == null || text.trim() === "") throw new Error("Nothing to import — pass a file or --text.");

  const rDir = recordDir();
  const item = appendInboxItem(
    { text, source: "drop", kind: "file", meta: hint ? { filename: hint } : null },
    { recordDir: rDir },
  );

  // Clean-CSV fast path: structure now, no LLM, no key needed.
  const structured = structureCsv(text);
  if (structured) {
    const source = sourceName(hint, "import");
    const merge = mergeDailyCsv(rDir, source, { header: structured.header, rows: structured.rows });
    updateInboxItems(
      [{ id: item.id, status: "structured", meta: { filename: hint, via: "csv", source, cells: merge.cells } }],
      { recordDir: rDir },
    );
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    return {
      inboxId: item.id, bytes: Buffer.byteLength(text), structured: true, source,
      metrics: merge.metrics, cells: merge.cells, dailyRows,
      pending: countPending(rDir),
      note: `Structured ${merge.cells} cells into daily/${source}.csv.`,
    };
  }

  rebuild({ recordDir: rDir });
  return {
    inboxId: item.id, bytes: Buffer.byteLength(text), structured: false,
    pending: countPending(rDir),
    note: "Landed raw in the inbox — run `agentqs structure` (needs an AI key for prose).",
  };
}

/** Turn pending inbox captures into daily rows (CSV free, prose needs a key). */
export async function structure(opts: { id?: string } = {}) {
  return structurePending({ id: opts.id });
}

// ---- config ---------------------------------------------------------------

const CONFIG_KEYS = ["provider", "model", "key", "theme", "username"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Safe, redacted view of the settable config. */
export function configList() {
  const cfg = readConfig();
  const llm = activeLlm(cfg);
  return {
    provider: llm?.type ?? cfg?.llmProvider ?? "",
    model: llm?.model ?? cfg?.model ?? "",
    key: llm?.apiKey ? `••••${llm.apiKey.slice(-4)}` : "",
    providers: effectiveProviders(cfg).length,
    theme: cfg?.theme ?? "system",
    username: cfg?.username ?? "",
    dataDir: recordDir().replace(/\/record$/, ""),
    keys: CONFIG_KEYS,
  };
}

export function configGet(key: string): string {
  const list = configList() as Record<string, unknown>;
  if (!CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new Error(`Unknown key "${key}". Settable: ${CONFIG_KEYS.join(", ")}`);
  }
  return String(list[key] ?? "");
}

/** Set one config value. `model` is validated against the chosen provider. */
export function configSet(key: string, value: string): { key: string; value: string } {
  if (!CONFIG_KEYS.includes(key as ConfigKey)) {
    throw new Error(`Unknown key "${key}". Settable: ${CONFIG_KEYS.join(", ")}`);
  }
  const cfg = requireConfig();
  switch (key as ConfigKey) {
    case "provider": {
      if (value && !isProvider(value)) throw new Error(`Unknown provider "${value}".`);
      cfg.llmProvider = value;
      if (!value) cfg.model = "";
      break;
    }
    case "model": {
      if (!cfg.llmProvider) throw new Error("Set a provider first: agentqs config set provider anthropic");
      // Model ids are live — accept any id the provider serves (see Settings → AI provider).
      if (!value.trim()) throw new Error("Give a model id (see Settings → AI provider for the live list).");
      cfg.model = value.trim();
      break;
    }
    case "key":
      cfg.llmKey = value;
      break;
    case "theme":
      if (!["light", "dark", "system"].includes(value)) throw new Error("theme must be light | dark | system.");
      cfg.theme = value;
      break;
    case "username":
      if (value.trim().length < 2) throw new Error("username too short.");
      cfg.username = value.trim();
      break;
  }
  writeConfig(cfg);
  return { key, value: key === "key" ? `••••${value.slice(-4)}` : value };
}

// ---- mentors (skills) -----------------------------------------------------

export function skillsList(): (Skill & { builtin: boolean })[] {
  return listSkills().map((s) => ({ ...s, builtin: isBuiltinSkill(s.id) }));
}

export function skillUpsert(input: UpsertSkillInput) {
  return upsertSkill(input);
}

export function skillRemove(id: string): { removed: string } {
  if (!removeSkill(id)) throw new Error(`No custom mentor "${id}".`);
  return { removed: id };
}

// ---- rebuild --------------------------------------------------------------

/** Rebuild the SQLite cache from the record. `verify` asserts determinism
 *  (two rebuilds → identical record hash), the guarantee behind the cache. */
export function rebuildCache(opts: { verify?: boolean } = {}) {
  const rDir = recordDir();
  const r = rebuild({ recordDir: rDir });
  if (opts.verify) {
    const h1 = recordHash(rDir);
    const r2 = rebuild({ recordDir: rDir });
    const ok = h1 === recordHash(rDir) && r.daily === r2.daily;
    return { ...r, verified: ok };
  }
  return r;
}

// ---- photos ---------------------------------------------------------------

/** Import a folder or the Mac photo library: EXIF + thumbnails + CLIP embed, all
 *  local. Originals never leave the machine — only metadata is recorded. */
export async function photosImport(opts: {
  folder?: string;
  library?: boolean;
  since?: string;
  caption?: boolean;
  push?: boolean;
}): Promise<ImportResult> {
  requireConfig();
  if (!opts.folder && !opts.library) {
    throw new Error("Give a folder path or --library (the Mac Photos library).");
  }
  return importPhotos(opts);
}

export function photosStatus(): PhotosStatus {
  return readPhotosStatus();
}

/** Text → image recall — "beach at sunset", "my dog". Local CLIP, no key. */
export async function photosSearch(query: string, limit = 8): Promise<ImageHit[]> {
  return findSimilarImages(query, limit);
}

export function photoContext(date: string, windowDays = 1): PhotoContext {
  return readPhotoContext(date, windowDays);
}

// ---- internals ------------------------------------------------------------

function requireConfig(): AppConfig {
  const cfg = readConfig();
  if (!cfg) throw new Error("agentqs isn't set up yet. Open the app once, or POST /api/setup.");
  return cfg;
}

function persistSync(id: string, freshCredential: string | undefined, at: string): void {
  const cfg = readConfig();
  if (!cfg) return;
  if (freshCredential && freshCredential.trim() && id !== "github") {
    cfg.sourceCreds = { ...(cfg.sourceCreds ?? {}), [id]: freshCredential.trim() };
  }
  if (id === "github") cfg.githubSyncedAt = at;
  else cfg.sourceSyncedAt = { ...(cfg.sourceSyncedAt ?? {}), [id]: at };
  try {
    writeConfig(cfg);
  } catch {
    /* non-fatal — the record already holds the data */
  }
}

function countPending(rDir: string): number {
  return readRecord(rDir).inbox.filter((i) => i.status === "pending").length;
}

/** A fetch stand-in that replays a JSON fixture file — offline sync for tests. */
function fixtureFetch(fixtureFile: string): typeof fetch {
  const body = fs.readFileSync(fixtureFile, "utf8");
  return (async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
}
