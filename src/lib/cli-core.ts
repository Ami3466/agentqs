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
  applyDailyEdits,
  mergeDailyCsv,
  rebuild,
  readInboxFromRecord,
  readRecord,
  recordHash,
  removeEventsBySource,
  revertEditsFromAppliedMeta,
  updateInboxItems,
} from "./record";
import { readJournal } from "./journal";
import { buildSources } from "./source-registry";
import { isValidInterval, type Interval } from "./sources";
import { importGithub, resolveGithubToken, resolveLogin } from "./importers/github";
import { ensureSession, importWhoop, mergeTokens, whoopFixtureFetch, whoopHrDir, whoopLogin, type WhoopCreds } from "./importers/whoop";
import {
  importPlugin,
  resolveCredential,
  resolveCredentialWithOrigin,
  resolveSyncCredential,
  windowDays,
  type FetchLike,
} from "./importers/plugin";
import type { JobProgress } from "./sync-jobs";
import { freshOAuthToken, oauthRedirectUri, resolveSyncCredentialFresh } from "./oauth";
import { pluginInstanceById, PLUGINS } from "./importers/registry";
import { importFile, resolveFilePath } from "./importers/file-plugin";
import { FILE_IMPORTERS, fileImporterById } from "./importers/files/registry";
import { sourceBundleById } from "./source-bundles";
import { recordSyncRun } from "./sync-runs";
import { pipelineReport } from "./pipeline";
import { doctorReport, migrateStore } from "./store-doctor";
import { structureCsv, sourceName } from "./structure";
import { autoStructureNewItem, csvLossText, notifyCsvLoss, structurePending } from "./structure-run";
import { looksText, sniffHead, MAX_INBOX_BYTES, MAX_STRUCTURE_BYTES } from "./import-tree";
import {
  acceptQualityAction,
  applySavedMerges,
  columnGuard,
  dropMergeRuleFor,
  type MergeOutcome,
  type QualityFinding,
  type QualityOutcome,
} from "./column-scan";
import { wipeDemoOnImport } from "./demo";
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
import { WHISPER_MODELS, installWhisperModel, removeWhisperModel, whisperInstalled } from "./whisper-local";
import type { DailyEdit } from "./record";

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
  const data = readJournal({ days: opts.limit && opts.limit > 0 ? opts.limit : "all" });
  const metrics = opts.source
    ? data.metrics.filter((m) => m.source === opts.source)
    : data.metrics;
  const days = opts.limit && opts.limit > 0 ? data.days.slice(0, opts.limit) : data.days;
  return {
    metrics,
    days,
    totalDays: data.totalDays,
    totalCells: data.totalCells,
    totalEvents: data.totalEvents,
    sources: [...new Set(data.metrics.map((m) => m.source))].sort(),
  };
}

export function journalEdit(edits: DailyEdit[]) {
  const rDir = recordDir();
  const result = applyDailyEdits(edits, { recordDir: rDir });
  const rebuilt = rebuild({ recordDir: rDir });
  return { ...result, dailyRows: rebuilt.daily };
}

export function logItems(limit = 50) {
  return readInboxFromRecord(recordDir()).slice(-limit).reverse();
}

/** Pending captures with FULL text — what a key-free CLI agent reads before
 *  supplying the structured CSV to `structure({id, csv})`. */
export function inboxPending() {
  const items = readInboxFromRecord(recordDir()).filter((i) => i.status === "pending");
  return { pending: items.length, items };
}

/** Resolve an inbox capture WITHOUT structuring it — the other half of the
 *  structuring workflow. "keep" files a PENDING item as a reference memo
 *  (searchable and recall-able, out of the queue — right for living documents:
 *  plans, open-items lists, notes with no dated metrics). "discard" drops an
 *  item of ANY status from every index (junk captures, dismissed
 *  notifications, un-keeping a reference memo) — idempotent, and it never
 *  touches merged cells: reverting a STRUCTURED item's data is `logReject`. */
export function inboxResolve(id: string, action: "keep" | "discard") {
  if (!id.trim()) throw new Error("Pass an inbox item id.");
  const rDir = recordDir();
  const item = readInboxFromRecord(rDir).find((i) => i.id === id);
  if (!item) throw new Error(`No inbox item "${id}".`);
  if (action === "keep" && item.status !== "pending") {
    throw new Error(`Item "${id}" is ${item.status}, not pending${item.status === "structured" ? " — use log reject to revert it" : ""}.`);
  }
  const status = action === "keep" ? "reference" : "discarded";
  if (item.status !== status) {
    updateInboxItems([{ id, status }], { recordDir: rDir });
    rebuild({ recordDir: rDir });
  }
  return { id, status, pending: readInboxFromRecord(rDir).filter((i) => i.status === "pending").length };
}

/** Local semantic recall (no API key): meaning-search over memos, sessions and
 *  imported journal text via the on-device embedding index. */
export async function recall(query: string, limit = 5) {
  const { semanticSearch } = await import("./embeddings");
  const hits = await semanticSearch(query, { limit });
  return { query, hits };
}

export function logReject(id: string) {
  if (!id.trim()) throw new Error("Pass a log item id.");
  const rDir = recordDir();
  const item = readInboxFromRecord(rDir).find((i) => i.id === id);
  if (!item) throw new Error(`No log item "${id}".`);
  let reverted = 0;
  if (item.status === "structured") {
    const result = applyDailyEdits(revertEditsFromAppliedMeta(item.meta), { recordDir: rDir });
    reverted = result.sets + result.clears;
  }
  // Rejecting a column merge must also forget its rule, or the next import would
  // silently redo what the user just undid.
  dropMergeRuleFor(item.meta);
  updateInboxItems(
    [{ id, status: "discarded", meta: { ...(item.meta && typeof item.meta === "object" ? item.meta : {}), rejectedAt: new Date().toISOString() } }],
    { recordDir: rDir },
  );
  const rebuilt = rebuild({ recordDir: rDir });
  return { id, discarded: true, reverted, dailyRows: rebuilt.daily };
}

export function whisperStatus() {
  const cfg = readConfig();
  const active = cfg?.voice?.whisperModel || "";
  return {
    active: active && whisperInstalled(active) ? active : "",
    lang: cfg?.voice?.whisperLang || "en",
    models: WHISPER_MODELS.map((m) => ({ ...m, installed: whisperInstalled(m.id) })),
  };
}

export async function whisperInstall(model: string) {
  if (!WHISPER_MODELS.some((m) => m.id === model)) throw new Error(`Unknown Whisper model "${model}".`);
  await installWhisperModel(model);
  const cfg = requireConfig();
  cfg.voice = { ...cfg.voice, provider: cfg.voice?.provider || "", whisperModel: model };
  writeConfig(cfg);
  return whisperStatus();
}

export function whisperRemove(model?: string) {
  const cfg = requireConfig();
  const target = model || cfg.voice?.whisperModel || "";
  if (!WHISPER_MODELS.some((m) => m.id === target)) throw new Error("No Whisper model selected.");
  removeWhisperModel(target);
  const latest = requireConfig();
  if (latest.voice?.whisperModel === target) {
    latest.voice = { ...latest.voice, provider: latest.voice.provider || "", whisperModel: "" };
    writeConfig(latest);
  }
  return whisperStatus();
}

// ---- sources: list / connect / interval / sync ----------------------------

export function sources() {
  return buildSources(readConfig());
}

/** The pipeline truth table: origin, credential provenance, schedule,
 *  scheduler presence, last run outcome and landed data per source. */
export function pipeline() {
  return pipelineReport();
}

/** Store health: sync-engine domain, evicted files, conflict twins, split store. */
export function doctor() {
  return doctorReport();
}

/** Move the store to a sync-safe location (default: the platform app-data dir). */
export function storeMigrate(opts: { to?: string; dryRun?: boolean } = {}) {
  return migrateStore(opts);
}

/** Save an API source's credential (Tier-1 plugin). This is "connect a source".
 *  An instance id ("spotify-2") connects an EXTRA account of the same source. */
export function connectSource(id: string, credential: string): { id: string; saved: boolean } {
  const plugin = pluginInstanceById(id)?.plugin;
  if (!plugin && id !== "github") {
    throw new Error(`Unknown API source "${id}". Try: github, ${PLUGINS.map((p) => p.id).join(", ")}`);
  }
  // The one rule: connected ⇔ a stored credential. There is NO keyless connect.
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

export interface CredentialTest {
  id: string;
  name: string;
  ok: true;
  detail: string; // what the probe proved ("3 days reachable", "@login")
}

/**
 * Prove a credential actually works BEFORE it is saved — one cheap authenticated
 * request against the real API, nothing written. Every connect flow (UI, CLI,
 * MCP) runs this first so a typo'd key fails loudly at paste time instead of
 * silently on the next scheduled sync. Throws with the API's own error.
 */
export async function testSourceCredential(id: string, credential?: string): Promise<CredentialTest> {
  if (id === "github") {
    const token = resolveGithubToken(credential);
    if (!token) throw new Error("GitHub needs a token — pass one or set GITHUB_TOKEN.");
    const login = await resolveLogin(token);
    return { id, name: "GitHub", ok: true, detail: `authenticated as @${login}` };
  }
  if (id === "whoop") {
    const wc = readConfig()?.whoopCreds;
    if (!wc?.email || !(wc.password || wc.refreshToken)) {
      throw new Error("WHOOP needs email + password — run 'agentqs whoop connect <email> <password>'.");
    }
    // ensureSession can ROTATE the refresh token — persist the returned creds
    // exactly like a sync does, or a mere test invalidates the stored token
    // and the next scheduled sync fails permanently.
    const s = await ensureSession(wc);
    const c2 = readConfig();
    if (c2) {
      c2.whoopCreds = s.creds;
      try {
        writeConfig(c2);
      } catch {
        /* non-fatal — the probe itself succeeded */
      }
    }
    return { id, name: "WHOOP (per-minute, unofficial)", ok: true, detail: `logged in as ${wc.email}` };
  }
  const inst = pluginInstanceById(id);
  if (!inst) {
    throw new Error(`Unknown API source "${id}". Try: github, whoop, ${PLUGINS.map((p) => p.id).join(", ")}`);
  }
  const { plugin, instanceId } = inst;
  // Include a DETECTED desktop-app token: testing is read-only, so probing it
  // before the user opts in is fine — syncing with it still requires connect.
  // An OAuth grant tests with a freshly minted token, like a real sync would.
  const cfg = readConfig();
  const cred = credential?.trim()
    ? credential.trim()
    : cfg?.sourceOAuth?.[instanceId]
      ? await resolveSyncCredentialFresh(plugin, undefined, cfg, instanceId) // grant → plugin's own credential format
      : resolveCredential(plugin, undefined, cfg, instanceId);
  if (plugin.requiresCredential && !cred) {
    throw new Error(`${plugin.name} needs a ${plugin.credentialLabel} to test.`);
  }
  const win = windowDays(3);
  const result = await plugin.fetch({ credential: cred, from: win.from, to: win.to });
  return {
    id: instanceId,
    name: plugin.name,
    ok: true,
    detail: `${result.table.rows.length} day(s) reachable in the last 3`,
  };
}

export interface SourceGuide {
  id: string;
  name: string;
  credentialLabel: string;
  url: string | null; // where to start (dashboard / token page)
  steps: string[];
  /** true → expiring tokens; connect runs the OAuth dance in the web app
   *  (Pipeline → Connect), which shows the redirect URI to register. */
  oauth: boolean;
  redirectUriHint: string; // what the provider app must have registered
}

/** How to connect a source — the guide behind every connect form, `agentqs
 *  source guide <id>` and the source_guide MCP tool. Covers the bespoke rows
 *  (GitHub, WHOOP) too, so no credentialed source is guide-less. */
export function sourceGuide(id: string): SourceGuide {
  const redirectUriHint = oauthRedirectUri("http://127.0.0.1:<port>");
  if (id === "github") {
    return {
      id, name: "GitHub", credentialLabel: "personal access token",
      url: "https://github.com/settings/tokens",
      steps: [
        "Create a token (classic with repo scope, or fine-grained with repository read access).",
        "Paste it in the GitHub row — or set GITHUB_TOKEN.",
      ],
      oauth: false, redirectUriHint,
    };
  }
  if (id === "whoop") {
    return {
      id, name: "WHOOP (per-minute, unofficial)", credentialLabel: "email + password",
      url: "https://developer-dashboard.whoop.com",
      steps: [
        "RETIRED UPSTREAM: WHOOP deleted the unofficial app-login endpoint (api-7.whoop.com) — email + password can no longer sync.",
        "Use the official WHOOP API row instead: 'agentqs source guide whoop-api' — recovery, strain & sleep via OAuth.",
        "Per-minute heart rate has no server-reachable API anymore; a browser automation could bring it back later.",
      ],
      oauth: false, redirectUriHint,
    };
  }
  const inst = pluginInstanceById(id);
  if (!inst) {
    throw new Error(`Unknown API source "${id}". Try: github, whoop, ${PLUGINS.map((p) => p.id).join(", ")}`);
  }
  const { plugin, instanceId } = inst;
  return {
    id: instanceId,
    name: plugin.name,
    credentialLabel: plugin.credentialLabel,
    url: plugin.credentialHelp?.url ?? null,
    steps: plugin.credentialHelp?.steps ?? [`Paste a ${plugin.credentialLabel}.`],
    oauth: Boolean(plugin.oauth),
    redirectUriHint,
  };
}

/** Import a DETECTED desktop app's login as this source's saved credential —
 *  the explicit "Connect (use detected app)" action. The token lands in
 *  sourceCreds like any pasted key: visible provenance, revoked by disconnect.
 *  Never called implicitly; without it a detected login syncs NOTHING. */
export function connectDetectedApp(id: string): { id: string; saved: boolean } {
  const inst = pluginInstanceById(id);
  if (!inst) throw new Error(`Unknown API source "${id}".`);
  const { credential, origin } = resolveCredentialWithOrigin(inst.plugin, undefined, readConfig(), inst.instanceId);
  if (origin !== "discovered" || !credential) {
    throw new Error(`No ${inst.plugin.name} desktop login detected on this machine.`);
  }
  return connectSource(id, credential);
}

/** Connect WHOOP via the unofficial app login — stores email + password (config
 *  0600, never committed); tokens are minted + rotated on the first sync. Two
 *  fields, so it's separate from the single-credential connectSource. */
export async function whoopConnect(email: string, password: string): Promise<{ email: string; saved: boolean }> {
  if (!email?.trim() || !password?.trim()) {
    throw new Error("WHOOP needs both an email and a password.");
  }
  // Prove the login BEFORE storing — the connect invariant (only a working
  // credential is ever saved). Keeping the minted tokens also spares the
  // first sync a second login.
  const session = await whoopLogin(email.trim(), password.trim());
  const cfg = requireConfig();
  cfg.whoopCreds = mergeTokens({ ...(cfg.whoopCreds ?? {}), email: email.trim(), password: password.trim() }, session);
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

function dailySourceFile(rDir: string, id: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`Invalid source id "${id}".`);
  return path.join(rDir, "daily", `${id}.csv`);
}

function hasRecordBackedSource(rDir: string, id: string): boolean {
  try {
    const file = dailySourceFile(rDir, id);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function graphKeyReferencesSource(key: string, id: string): boolean {
  return key === `count:source:${id}` || key.startsWith(`metric:${id}.`);
}

function forgetSourceConfig(cfg: AppConfig, id: string): void {
  if (cfg.sourceCreds) delete cfg.sourceCreds[id];
  if (cfg.sourceOAuth) delete cfg.sourceOAuth[id]; // an OAuth grant is a stored credential too
  if (cfg.sourceSyncedAt) delete cfg.sourceSyncedAt[id];
  if (cfg.sourceIntervals) delete cfg.sourceIntervals[id];
  if (cfg.savedGraphs) {
    cfg.savedGraphs = cfg.savedGraphs.filter(
      (g) => !graphKeyReferencesSource(g.xKey, id) && !graphKeyReferencesSource(g.yKey, id),
    );
  }
}

function removeDailySourceFile(rDir: string, id: string): void {
  try {
    fs.rmSync(dailySourceFile(rDir, id), { force: true });
  } catch {
    /* non-fatal — nothing to remove */
  }
  // Events the source landed (extension scrapes write record/events.jsonl with
  // source == daily source id) leave the record with it.
  removeEventsBySource(id, { recordDir: rDir });
}

function forgetSourceConfigs(cfg: AppConfig, ids: string[]): void {
  for (const sourceId of ids) forgetSourceConfig(cfg, sourceId);
}

/** Remove an import/source: drop record/daily/<id>.csv, forget credential + sync
 *  time + schedule + saved graphs that point at it, and rebuild. This covers
 *  registered integrations and generic record-backed imports discovered from CSV. */
export function disconnectSource(id: string): { id: string; removed: boolean; dailyRows: number } {
  const rDir = recordDir();
  const automation = isAutomation(id);
  const bundle = sourceBundleById(id);
  const bundleSourceIds = bundle?.sourceIds(rDir) ?? [];
  const recordBacked = hasRecordBackedSource(rDir, id);
  const known =
    automation ||
    Boolean(bundle && bundleSourceIds.length) ||
    id === "github" ||
    id === "whoop" ||
    Boolean(pluginInstanceById(id)) || // includes "<plugin>-<n>" extra accounts
    Boolean(fileImporterById(id)) ||
    recordBacked;
  if (!known) {
    throw new Error(
      `Unknown source "${id}". Try a connected source or a record-backed import in record/daily/<source>.csv.`,
    );
  }
  if (bundle) {
    for (const sourceId of bundleSourceIds) removeDailySourceFile(rDir, sourceId);
    const cfg = requireConfig();
    forgetSourceConfigs(cfg, [id, ...bundleSourceIds]);
    writeConfig(cfg);
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    return { id, removed: true, dailyRows };
  }
  removeDailySourceFile(rDir, id);
  // Automations carry their own record + secrets — removeAutomation clears them.
  if (automation) {
    removeAutomation(id);
    const latest = readConfig();
    if (latest) {
      forgetSourceConfig(latest, id);
      writeConfig(latest);
    }
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    return { id, removed: true, dailyRows };
  }
  const cfg = requireConfig();
  if (id === "github") {
    delete cfg.githubToken;
    delete cfg.githubSyncedAt;
  } else if (id === "whoop") {
    delete cfg.whoopCreds;
    try {
      fs.rmSync(whoopHrDir(rDir), { recursive: true, force: true }); // per-minute HR files
    } catch {
      /* non-fatal */
    }
  }
  forgetSourceConfig(cfg, id);
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

export interface SyncSourceOpts {
  id: string;
  credential?: string;
  days?: number;
  fixture?: string;
  login?: string; // github only — public commit sync without a token
  hrDays?: number; // whoop only — per-minute HR backfill window
  /** Live phase/percent reporting for the background job bar; optional. */
  onProgress?: JobProgress;
}

/** Run one API source now: fetch → merge → rebuild, persisting the sync time.
 *  `fixture` (a JSON file) drives it offline for GitHub-style ships-when tests. */
export async function syncSource(opts: SyncSourceOpts): Promise<SyncResult> {
  // Every attempt lands in the run ledger — success and failure — so the
  // pipeline report and the Pipeline tab can tell a broken sync from a healthy one.
  try {
    const result = await syncSourceInner(opts);
    recordSyncRun(opts.id, true);
    return result;
  } catch (e) {
    recordSyncRun(opts.id, false, (e as Error).message);
    throw e;
  }
}

async function syncSourceInner(opts: SyncSourceOpts): Promise<SyncResult> {
  const rDir = recordDir();
  const win = windowDays(opts.days && opts.days > 0 ? opts.days : 90);
  const cfg = readConfig();
  const now = new Date().toISOString();
  const progress: JobProgress = opts.onProgress ?? (() => {});

  if (opts.id === "github") {
    const token = resolveGithubToken(opts.credential);
    const fetchImpl = opts.fixture ? fixtureFetch(opts.fixture) : undefined;
    if (!token && !fetchImpl && !opts.login) {
      throw new Error("GitHub needs a token — pass --credential or set GITHUB_TOKEN.");
    }
    progress("fetching commits from GitHub", 15);
    const s = await importGithub({ token, login: opts.login, from: win.from, to: win.to, recordDir: rDir, fetchImpl });
    progress("merging into the record", 75);
    applySavedMerges(rDir); // keep accepted column merges merged on every sync
    progress("rebuilding the cache", 88);
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
    progress("pulling WHOOP days + per-minute heart rate", 15);
    const s = await importWhoop({
      creds: creds!,
      from: win.from,
      to: win.to,
      recordDir: rDir,
      fetchImpl,
      hrDays: opts.hrDays && opts.hrDays > 0 ? opts.hrDays : undefined,
    });
    progress("merging into the record", 75);
    applySavedMerges(rDir);
    progress("rebuilding the cache", 88);
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    const c2 = readConfig();
    if (c2) {
      c2.whoopCreds = s.creds;
      c2.sourceSyncedAt = { ...(c2.sourceSyncedAt ?? {}), whoop: now };
      writeConfig(c2);
    }
    return {
      id: "whoop", name: "WHOOP (per-minute, unofficial)", from: win.from, to: win.to,
      days: s.daysWithData, metrics: s.metrics, cells: s.cells, dailyRows, syncedAt: now,
    };
  }

  const inst = pluginInstanceById(opts.id);
  if (!inst) {
    throw new Error(`Unknown API source "${opts.id}". Try: github, whoop, ${PLUGINS.map((p) => p.id).join(", ")}`);
  }
  const { plugin, instanceId } = inst;
  const fetchImpl = opts.fixture ? fixtureFetch(opts.fixture) : undefined;
  // Gated: a discovered desktop-app token only syncs after the user opted in.
  // An OAuth grant mints a FRESH access token here (refreshed + persisted), so
  // expiring-token sources survive scheduled syncs. Fixtures stay offline.
  const credential = fetchImpl
    ? resolveSyncCredential(plugin, opts.credential, cfg, instanceId)
    : await resolveSyncCredentialFresh(plugin, opts.credential, cfg, instanceId);
  if (plugin.requiresCredential && !credential && !fetchImpl) {
    const detected = Boolean(resolveCredential(plugin, undefined, cfg, instanceId));
    throw new Error(
      detected
        ? `${plugin.name} desktop app detected but not connected. Run 'agentqs source connect ${instanceId}' to approve using its login, or pass --credential.`
        : `${plugin.name} needs a ${plugin.credentialLabel}. Pass --credential or run 'agentqs source connect ${instanceId} <cred>'.`,
    );
  }
  progress(`fetching your ${plugin.name} data`, 15);
  const summary = await importPlugin(plugin, { credential, from: win.from, to: win.to, fetchImpl }, rDir, instanceId);
  progress("merging into the record", 75);
  applySavedMerges(rDir);
  progress("rebuilding the cache", 88);
  const dailyRows = rebuild({ recordDir: rDir }).daily;
  persistSync(instanceId, opts.credential, now);
  return {
    id: instanceId, name: plugin.name, from: summary.from, to: summary.to,
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
  // Extra accounts ("spotify-2") carry their own credential — sync them too.
  for (const key of Object.keys(cfg?.sourceCreds ?? {})) {
    const inst = pluginInstanceById(key);
    if (inst && inst.plugin.live && key !== inst.plugin.id && !candidates.includes(key)) candidates.push(key);
  }
  for (const id of candidates) {
    const hasCred =
      id === "github"
        ? Boolean(resolveGithubToken())
        : id === "whoop"
          ? Boolean(cfg?.whoopCreds?.email && (cfg.whoopCreds.password || cfg.whoopCreds.refreshToken))
          : Boolean(resolveSyncCredential(pluginInstanceById(id)!.plugin, undefined, cfg, id));
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
  try {
    const result = await syncFileSourceInner(opts);
    recordSyncRun(opts.id, true);
    return result;
  } catch (e) {
    recordSyncRun(opts.id, false, (e as Error).message);
    throw e;
  }
}

async function syncFileSourceInner(opts: {
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
  // A one-shot lifetime export (Takeout JSON, Apple Health) defaults to ALL
  // history — a rolling 90-day window would silently discard most of it.
  const fullHistory = importer.fullHistoryDefault || (importer.id === "chrome" && /\.json$/i.test(filePath));
  const win = windowDays(opts.days && opts.days > 0 ? opts.days : 90);
  const from = opts.days && opts.days > 0 ? win.from : fullHistory ? "0001-01-01" : win.from;
  const summary = await importFile(importer, { path: filePath, from, to: win.to }, rDir);
  applySavedMerges(rDir);
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
export async function importRaw(opts: { file?: string; text?: string; name?: string }): Promise<ImportRawResult> {
  let text = opts.text;
  let hint = opts.name;
  let oversized = false;
  if (opts.file) {
    const st = fs.statSync(opts.file);
    if (st.isDirectory()) {
      throw new Error("That's a folder — `agentqs import <folder>` (or the MCP `import_tree` tool) runs the fully accounted folder import.");
    }
    if (st.size === 0) throw new Error("Nothing to import — the file is empty.");
    // Refuse loudly what can't land as text — utf8-reading a binary would put
    // silent garbage in the record.
    if (!looksText(sniffHead(opts.file))) {
      throw new Error(
        `Binary file — no importer claims it, nothing landed. Try \`agentqs import <folder>\` to route known formats, or a dedicated importer.`,
      );
    }
    if (st.size > MAX_STRUCTURE_BYTES) {
      throw new Error("Text too large — needs a dedicated importer, nothing landed.");
    }
    // Bigger than a memo may be, but clean CSV never lands raw — it structures.
    oversized = st.size > MAX_INBOX_BYTES;
    text = fs.readFileSync(opts.file, "utf8");
    hint = hint ?? path.basename(opts.file);
  }
  if (text == null || text.trim() === "") throw new Error("Nothing to import — pass a file or --text.");
  // The {text} path gets the same guards as the file path — a face must not
  // land what its sibling refuses.
  if (text.includes("\u0000")) {
    throw new Error("Binary content — no importer claims it, nothing landed.");
  }
  if (Buffer.byteLength(text) > MAX_STRUCTURE_BYTES) {
    throw new Error("Text too large — needs a dedicated importer, nothing landed.");
  }
  oversized = oversized || Buffer.byteLength(text) > MAX_INBOX_BYTES;

  // Clean-CSV fast path probe runs BEFORE the raw landing so an oversized
  // file is only refused when it would land as an unstructurable megamemo.
  const structured = structureCsv(text);
  if (oversized && !structured) {
    throw new Error("Text too large to land raw — needs a dedicated importer, nothing landed.");
  }

  // A real import clears the demo record BEFORE merging, so real rows never land
  // in demo CSVs that a later wipe would delete (structurePending wipes for prose).
  wipeDemoOnImport();
  const rDir = recordDir();
  const item = appendInboxItem(
    {
      text: oversized ? `[${hint ?? "import"}: ${Buffer.byteLength(text).toLocaleString()} bytes of clean CSV — merged, body not kept raw]` : text,
      source: "drop",
      kind: "file",
      meta: hint ? { filename: hint } : null,
    },
    { recordDir: rDir },
  );
  if (structured) {
    const source = sourceName(hint, "import");
    const merge = mergeDailyCsv(rDir, source, { header: structured.header, rows: structured.rows });
    // A partial parse must never read as a full landing — the loss becomes a
    // pending notification and is named in the return note.
    notifyCsvLoss(rDir, hint, structured);
    const loss = csvLossText(structured);
    updateInboxItems(
      [{
        id: item.id,
        status: "structured",
        // Same meta shape as structurePending — `applied` lets the Log's Reject
        // revert this import's cells, exactly like a GUI-structured drop.
        meta: {
          filename: hint, via: "csv", source, cells: merge.cells,
          metrics: merge.metrics, structuredAt: new Date().toISOString(), applied: merge.applied,
        },
      }],
      { recordDir: rDir },
    );
    // A dropped CSV is structuring too — run the column check so a manual
    // re-import folds into accepted merges and new duplicates get notified.
    columnGuard(rDir);
    const dailyRows = rebuild({ recordDir: rDir }).daily;
    return {
      inboxId: item.id, bytes: Buffer.byteLength(text), structured: true, source,
      metrics: merge.metrics, cells: merge.cells, dailyRows,
      pending: countPending(rDir),
      note: `Structured ${merge.cells} cells into daily/${source}.csv.${loss ? ` WARNING — did NOT fully land: ${loss}.` : ""}`,
    };
  }

  // Auto-structure (Settings): prose skips the pending queue via the LLM route.
  // Runs before the rebuild — structurePending rebuilds itself when it merges.
  const auto = await autoStructureNewItem(item.id);
  const autoHit = auto?.results.find((r) => r.id === item.id && r.status === "structured");
  if (!auto || auto.structured === 0) rebuild({ recordDir: rDir });
  if (auto && autoHit) {
    return {
      inboxId: item.id, bytes: Buffer.byteLength(text), structured: true, source: autoHit.source,
      metrics: autoHit.metrics, cells: autoHit.rowsAdded, dailyRows: auto.dailyRows ?? undefined,
      pending: auto.pending,
      note: `Auto-structured ${autoHit.rowsAdded ?? 0} cells into daily/${autoHit.source}.csv.`,
    };
  }

  return {
    inboxId: item.id, bytes: Buffer.byteLength(text), structured: false,
    pending: countPending(rDir),
    note: "Landed raw in the inbox — run `agentqs structure` (needs an AI key for prose).",
  };
}

/** Turn pending inbox captures into daily rows (CSV free, prose needs a key). */
export async function structure(opts: { id?: string; csv?: string } = {}) {
  return structurePending({ id: opts.id, csv: opts.csv });
}

/** Folder import with a full accounting — every file in exactly one bucket,
 *  residue reported loudly, receipt persisted as an inbox notification. */
export { importTree } from "./import-tree";

/** The index audit: deterministic evidence (impossible dates, one-day sources,
 *  coverage holes, stale sources, outliers) for an AI review pass. Read-only. */
export { auditIndex } from "./audit";

// ---- data-quality scanner -----------------------------------------------------

export interface ScanResult {
  findings: QualityFinding[];
  autoMerged: MergeOutcome[];
  notified: number;
  fixed: Array<QualityOutcome & { kind: QualityFinding["kind"]; key: string }>;
  dailyRows: number | null;
}

/**
 * Scan the daily record for quality issues: duplicate / near-duplicate columns
 * (merge), dead all-zero columns (drop), messy numeric values (clean). Re-applies
 * saved merge rules, queues each new finding as an inbox notification (structuring
 * one applies the fix), and with `fix` applies every suggested fix right away.
 */
export function scan(opts: { fix?: boolean } = {}): ScanResult {
  const rDir = recordDir();
  const guard = columnGuard(rDir);
  const fixed: ScanResult["fixed"] = [];
  if (opts.fix) {
    const inbox = readInboxFromRecord(rDir);
    for (const f of guard.findings) {
      if (f.notificationStatus !== "pending") continue; // dismissed stays dismissed
      const action =
        f.kind === "merge"
          ? ({ type: "merge", from: f.key, into: f.into! } as const)
          : ({ type: f.kind, key: f.key } as const);
      const outcome = acceptQualityAction(rDir, action);
      fixed.push({ ...outcome, kind: f.kind, key: f.key });
      const item = inbox.find((i) => i.id === f.notificationId);
      updateInboxItems(
        [{
          id: f.notificationId,
          status: "structured",
          meta: {
            ...(item?.meta && typeof item.meta === "object" ? item.meta : {}),
            structuredAt: new Date().toISOString(),
            via: f.kind,
            source: outcome.source,
            cells: outcome.cells,
            applied: outcome.applied,
          },
        }],
        { recordDir: rDir },
      );
      f.notificationStatus = "structured";
    }
  }
  const mutated = guard.autoMerged.length > 0 || guard.notified > 0 || fixed.length > 0;
  const rebuilt = mutated ? rebuild({ recordDir: rDir }) : null;
  return {
    findings: guard.findings,
    autoMerged: guard.autoMerged,
    notified: guard.notified,
    fixed,
    dailyRows: rebuilt?.daily ?? null,
  };
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
