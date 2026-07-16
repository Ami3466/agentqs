/**
 * cli-core — the one brain behind every non-GUI face of agentqs.
 *
 * The `agentqs` CLI (bin/agentqs-cli.ts) and the MCP server (bin/mcp.ts) both call
 * ONLY these functions; the Next app's API routes call the same underlying lib.
 * So "import a file, connect a source, schedule a sync, run a sync, add a mentor,
 * rebuild, query, chat" behave identically from the terminal, from an MCP client
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
import { prepareSql } from "./query-async";
import {
  appendInboxItem,
  applyDailyEdits,
  mergeDailyCsv,
  parseCsv,
  rebuild,
  readInboxFromRecord,
  readRecord,
  recordHash,
  refreshSyncCache,
  removeEventsBySource,
  revertEditsFromAppliedMeta,
  updateInboxItems,
  type SyncCacheChange,
} from "./record";
import { readJournal } from "./journal";
import { GOOGLE_PRODUCTS, googleEnabled, googleProductById } from "./google";
import { googleState, setGoogleProducts, toggleGoogleProducts, type GoogleState } from "./google-connect";
import { buildSources } from "./source-registry";
import { isValidInterval, type Interval } from "./sources";
import { importGithub, resolveGithubToken, resolveLogin } from "./importers/github";
import {
  clearWhoopCreds,
  ensureSession,
  importWhoop,
  isWhoopInstance,
  mergeTokens,
  setWhoopCreds,
  whoopCredsFor,
  whoopFixtureFetch,
  whoopHasCredential,
  whoopHrDir,
  whoopLogin,
  WHOOP_BASE_ID,
  type WhoopCreds,
} from "./importers/whoop";
import {
  BACKFILL_CHUNK_DAYS,
  BACKFILL_FLOOR,
  importPlugin,
  resolveCredential,
  resolveCredentialWithOrigin,
  resolveSyncCredential,
  windowDays,
  type FetchLike,
  type ImporterPlugin,
  type PluginImportSummary,
} from "./importers/plugin";
import { noteSyncOutcome, type JobProgress } from "./sync-jobs";
import { googlePluginOn } from "./google";
import { recordTimeZone } from "./importers/plugin";
import { beginOAuth, freshOAuthToken, oauthRedirectUri, resolveSyncCredentialFresh } from "./oauth";
import {
  driveImportConfig,
  listDriveFolder,
  pullDriveFile,
  resolveDriveFile,
  setDriveImportFolder,
} from "./drive-import";
import { pluginInstanceById, SOURCE_PLUGINS } from "./importers/registry";
import { importFile, resolveFilePath } from "./importers/file-plugin";
import { FILE_IMPORTERS, fileImporterById } from "./importers/files/registry";
import { sourceBundleById } from "./source-bundles";
import { readBackfillState, recordSyncRun, writeBackfillState } from "./sync-runs";
import { pipelineReport } from "./pipeline";
import { buildCoverage } from "./coverage";
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
import { listRules, removeRule, testRule, upsertRule, type RuleInput } from "./rules";
import { listSkills, removeSkill, restoreBuiltinSkills, upsertSkill, isBuiltinSkill, type UpsertSkillInput } from "./skills-store";
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
  const { sql: capped, limit: cap } = prepareSql(sql, limit);
  const file = dbPath();
  if (!fs.existsSync(file)) throw new Error("No cache yet — run `agentqs rebuild` first.");
  const db = openReadonly(file);
  try {
    // Enforce the cap while reading, not via the appended LIMIT — a "limit" the regex
    // saw in a subquery/alias skips the append, so `.all()` would materialize the
    // whole table. Iterating stops at the ceiling regardless.
    const stmt = db.prepare(capped);
    const rows: Record<string, unknown>[] = [];
    for (const r of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
      rows.push(r);
      if (rows.length >= cap) break;
    }
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, count: rows.length };
  } finally {
    db.close();
  }
}

// ---- agent rules ----------------------------------------------------------

/** "When X → message me." X is a clock time or a data threshold (a plain numeric
 *  compare, no AI); the message is a fixed line or an AI brief. The Settings Agent
 *  tab, /api/rules, the CLI and the MCP tool are all thin faces over these four. */
export function rulesList() {
  return { rules: listRules() };
}
export function rulesUpsert(input: RuleInput) {
  return { rule: upsertRule(input), rules: listRules() };
}
export function rulesRemove(id: string) {
  return { ...removeRule(id), rules: listRules() };
}
export async function rulesTest(id: string) {
  return { ok: true, rule: await testRule(id) };
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
  // Patch only the daily sources this edit rewrote — a full rebuild re-reads
  // events.jsonl (hundreds of MB on a real record) and blocks the server for minutes
  // just to fix one junk cell. Fall back to a rebuild only when there is no cache yet.
  const dailyRows = landDailyEditInCache(rDir, result.sources);
  return { ...result, dailyRows };
}

/** Patch the cache for a set of daily sources a journal edit / revert rewrote, or
 *  fall back to the one full rebuild when no cache exists yet. */
function landDailyEditInCache(rDir: string, sources: string[]): number {
  if (sources.length === 0) {
    const cached = refreshSyncCache({ sources: [] }, { recordDir: rDir });
    return cached ? cached.dailyRows : rebuild({ recordDir: rDir }).daily;
  }
  const patched = refreshSyncCache({ sources }, { recordDir: rDir });
  return patched ? patched.dailyRows : rebuild({ recordDir: rDir }).daily;
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

/** The record's shape: every source with total rows, day-span and a per-year
 *  histogram, plus the year axis and totals. Powers the Overview heatmap. */
export function coverage() {
  return buildCoverage();
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
    throw new Error(`Unknown API source "${id}". Try: github, ${SOURCE_PLUGINS.map((p) => p.id).join(", ")}`);
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
  if (isWhoopInstance(id)) {
    const wc = whoopCredsFor(readConfig(), id);
    if (!whoopHasCredential(wc)) {
      throw new Error("WHOOP needs email + password — run 'agentqs whoop connect <email> <password>'.");
    }
    // ensureSession can ROTATE the refresh token — persist the returned creds
    // exactly like a sync does, or a mere test invalidates the stored token
    // and the next scheduled sync fails permanently.
    const s = await ensureSession(wc!);
    const c2 = readConfig();
    if (c2) {
      setWhoopCreds(c2, id, s.creds);
      try {
        writeConfig(c2);
      } catch {
        /* non-fatal — the probe itself succeeded */
      }
    }
    return { id, name: whoopInstanceName(id), ok: true, detail: `logged in as ${wc!.email}` };
  }
  const inst = pluginInstanceById(id);
  if (!inst) {
    throw new Error(`Unknown API source "${id}". Try: github, whoop, ${SOURCE_PLUGINS.map((p) => p.id).join(", ")}`);
  }
  const { plugin, instanceId } = inst;
  // Include a DETECTED desktop-app token: testing is read-only, so probing it
  // before the user opts in is fine — syncing with it still requires connect.
  // An OAuth grant tests with a freshly minted token, like a real sync would.
  const cfg = readConfig();
  // TEST THE CREDENTIAL A SYNC WOULD ACTUALLY USE. This used to gate on
  // `sourceOAuth[instanceId]` — the RAW instance slot, not `oauthGrantKey` — so Google
  // never matched (its grant lives at `sourceOAuth.google`, shared by Calendar and
  // Gmail). It took the stale branch, handed Google an access token that expires in an
  // hour (or the refresh token itself, as a Bearer), and answered "401 Invalid
  // Credentials". Every Google test more than an hour after connecting failed, on a
  // connection that was perfectly healthy — and sent people back through the whole
  // OAuth dance for nothing. `resolveSyncCredentialFresh` already falls back to
  // env/sourceCreds when there is no grant, so it is the ONLY branch needed.
  const cred = credential?.trim()
    ? credential.trim()
    : await resolveSyncCredentialFresh(plugin, undefined, cfg, instanceId);
  if (plugin.requiresCredential && !cred) {
    throw new Error(`${plugin.name} needs a ${plugin.credentialLabel} to test.`);
  }
  const win = windowDays(3);
  // A plugin with a dedicated probe (fetch() has real side effects — gdrive_backup
  // uploads an archive) proves the credential without running the side effect.
  if (plugin.probe) {
    const detail = await plugin.probe({ credential: cred, from: win.from, to: win.to });
    return { id: instanceId, name: plugin.name, ok: true, detail };
  }
  const result = await plugin.fetch({ credential: cred, from: win.from, to: win.to });
  return {
    id: instanceId,
    name: plugin.name,
    ok: true,
    detail: `${result.table.rows.length} day(s) reachable in the last 3`,
  };
}

/** The OAuth dance, started from the CLI/MCP instead of the web connect form —
 *  same beginOAuth underneath (app creds + state stored in config). The user
 *  opens the returned URL; the RUNNING app at `origin` receives the callback
 *  and stores the grant, so the provider app must have the redirect URI
 *  registered and the app must be up when the browser bounces back. */
export function sourceAuthorize(
  id: string,
  clientId = "",
  clientSecret = "",
  origin = "http://127.0.0.1:3000",
): { id: string; authorizeUrl: string; redirectUri: string; note: string } {
  const base = origin.trim().replace(/\/$/, "");
  // Empty client id/secret = REUSE the saved app key — signing in again, or adding a
  // second account, never re-enters the key. beginOAuth throws a clear "no key saved
  // yet" if nothing was ever registered; pass creds only to REPLACE the saved key.
  const r = beginOAuth(id, clientId.trim(), clientSecret.trim(), base);
  return {
    id,
    ...r,
    note:
      `Open the URL and approve access; the app running at ${base} completes the connection. ` +
      `The provider app must have ${r.redirectUri} registered as a redirect URI.`,
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
      url: "https://app.whoop.com",
      steps: [
        "Your WHOOP app login — the same email + password you use in the WHOOP app. It is stored in config (0600) and minted into rotating tokens on the first sync.",
        "This is the ONLY source of per-minute heart rate (recovery/strain/sleep also land). The official WHOOP API row (OAuth) has no per-minute stream.",
        "If the login fails with a network/DNS error, api-7.whoop.com is unreachable FROM THAT MACHINE — that is not your password, and it can differ between your laptop and a hosted instance.",
      ],
      oauth: false, redirectUriHint,
    };
  }
  const inst = pluginInstanceById(id);
  if (!inst) {
    throw new Error(`Unknown API source "${id}". Try: github, whoop, ${SOURCE_PLUGINS.map((p) => p.id).join(", ")}`);
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

/** Display name for a WHOOP account — the base is unlabelled, extras are numbered
 *  ("WHOOP · account 2") so two athletes' rows are distinguishable. */
export function whoopInstanceName(instanceId: string): string {
  const base = "WHOOP (per-minute, unofficial)";
  const m = instanceId.match(/^whoop-(\d+)$/);
  return m ? `WHOOP · account ${m[1]} (per-minute, unofficial)` : base;
}

/** Connect a WHOOP account via the unofficial app login — stores email + password
 *  (config 0600, never committed); tokens are minted + rotated on the first sync.
 *  `instanceId` (default "whoop") is the account: a second athlete connects as
 *  "whoop-2" into its own slot, file and schedule. Two fields, so it's separate
 *  from the single-credential connectSource. */
export async function whoopConnect(
  email: string,
  password: string,
  instanceId: string = WHOOP_BASE_ID,
): Promise<{ email: string; saved: boolean; id: string }> {
  if (!email?.trim() || !password?.trim()) {
    throw new Error("WHOOP needs both an email and a password.");
  }
  if (!isWhoopInstance(instanceId)) throw new Error(`"${instanceId}" is not a WHOOP account id.`);
  // Prove the login BEFORE storing — the connect invariant (only a working
  // credential is ever saved). Keeping the minted tokens also spares the
  // first sync a second login.
  const session = await whoopLogin(email.trim(), password.trim());
  const cfg = requireConfig();
  const prev = whoopCredsFor(cfg, instanceId) ?? {};
  setWhoopCreds(cfg, instanceId, mergeTokens({ ...prev, email: email.trim(), password: password.trim() }, session));
  writeConfig(cfg);
  return { email: email.trim(), saved: true, id: instanceId };
}

/** The Google card as one brain: read state, or tick/untick products (Google →
 *  Gmail → Sent) behind the one shared OAuth key. No args → just the current state.
 *  `{products}` replaces the whole ticked set (the checkboxes); `{enable,disable}`
 *  nudges a few (the CLI flags). Ticking is NOT connecting — a product the stored
 *  grant lacks the scope for comes back as `needsAuthorize`, re-authorize widens
 *  the same key. MCP tool `google_products`; API GET/POST `/api/google`. */
export function google(
  opts: { products?: string[]; enable?: string[]; disable?: string[] } = {},
): GoogleState {
  if (opts.products) return setGoogleProducts(opts.products);
  if (opts.enable?.length || opts.disable?.length) {
    return toggleGoogleProducts(opts.enable ?? [], opts.disable ?? []);
  }
  return googleState();
}

/** Set a source's sync cadence — this is "set up an automated import". `off`,
 *  `hourly`, `daily`, `weekly`. API sources auto-sync when due; manual sources
 *  badge stale when overdue. A backup target isn't a source: its cadence lives
 *  under `config.backup` and only `setBackupInterval` may set it. */
export function setInterval(id: string, interval: string): { id: string; interval: Interval } {
  if (!isValidInterval(interval)) {
    throw new Error(`Invalid interval "${interval}". Use: off, hourly, daily, weekly.`);
  }
  if (pluginInstanceById(id)?.plugin.backupTarget) {
    throw new Error(
      `${id} is a backup target, not a data source — set its cadence with \`agentqs backup drive --schedule ${interval}\` ` +
        `(API: POST /api/backup {"target":"drive","schedule":"${interval}"}).`,
    );
  }
  if (pluginInstanceById(id)?.plugin.credentialOnly) {
    throw new Error(`${id} is read-on-request, not a scheduled source — pull it with \`agentqs drive pull <file>\`.`);
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

/** The newest date a source has already landed, or null when it holds nothing.
 *  This is what tells an importer "resume from here" vs "this is a first import,
 *  take everything" — a blind trailing window does neither. */
function lastDailyDate(rDir: string, id: string): string | null {
  const file = dailySourceFile(rDir, id);
  if (!fs.existsSync(file)) return null;
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  const di = header.indexOf("date");
  if (di < 0) return null;
  const dates = rows.map((r) => (r[di] ?? "").trim()).filter(Boolean).sort();
  return dates.at(-1) ?? null;
}

/** Shift an ISO date by n days (negative = back). */
function shiftIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * WHICH WINDOW a sync should ask for. The one rule, for every source:
 *
 *   --days N        → exactly that, as asked.
 *   record empty    → the FIRST import takes the history, as far back as this API
 *                     goes (`backfillDays`).
 *   record has rows → resume from the last day recorded, minus a week of overlap
 *                     for data that arrives late.
 *
 * A flat trailing "last 90 days" - what every source used to send - is wrong twice
 * over: it lands a sliver of a lifetime, and because EVERY later sync re-asks for
 * that same window, the years before it are never fetched even once. A source is
 * then permanently capped at whatever its first 90 days held.
 */
export function syncWindow(
  rDir: string,
  id: string,
  opts: { days?: number; backfillDays?: number; today?: Date } = {},
): { from: string; to: string; firstImport: boolean } {
  const now = opts.today ?? new Date();
  const to = now.toISOString().slice(0, 10);
  if (opts.days && opts.days > 0) {
    return { from: windowDays(opts.days, now).from, to, firstImport: false };
  }
  const last = lastDailyDate(rDir, id);
  if (!last) {
    // A first import has no window: it DISCOVERS one (backfillPlugin walks back until
    // the source runs dry). `backfillDays` is only for an API that cannot walk —
    // then, and only then, is there a number.
    const from = opts.backfillDays
      ? windowDays(opts.backfillDays, now).from
      : windowDays(BACKFILL_CHUNK_DAYS, now).from;
    return { from, to, firstImport: true };
  }
  // CLAMP. `from` is derived from the record, and the record can hold a FUTURE date —
  // a journal-edit on next month, an imported CSV of planned events, a source that
  // records scheduled items. Then `from` lands after `to` and the window is INVERTED,
  // for good: Calendar would send timeMin > timeMax and 400 on every sync, and an API
  // that just answers `[]` would report "ok · 0 days" forever while nothing in the
  // record ever removes the future row that caused it.
  return { from: minIso(shiftIso(last, -7), to), to, firstImport: false };
}

/** The earlier of two ISO dates. */
function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * THE FIRST IMPORT: ask the source where its history begins, never assume.
 *
 * Walks backwards a year at a time TO THE FLOOR. No constant decides how far back your
 * life goes — the data does. A fixed default cannot: five years gave one calendar 1,077
 * days, ten gave it 1,824, and its history actually began at 1,891. Whatever number you
 * pick, it is a guess about a stranger, and the days it clips are days they never find
 * out they are missing.
 *
 * IT USED TO STOP AFTER TWO EMPTY YEARS, and that was the same mistake wearing a
 * different hat. An empty chunk was read as "the source has run dry", but a life is not
 * a tidy run of activity ending in silence — it has GAPS. Two quiet years is a job
 * change, a broken strap, a phone you stopped carrying, an app you came back to. The
 * walk hit the gap, concluded the history had ended there, and never asked about
 * anything older. Everything before the gap was silently unreachable, by any command,
 * forever — and the sync reported ok. (Proved with Gmail: mail in 2026 and mail in
 * 2019, three quiet years between, and the walk never asked Gmail about anything before
 * 2023. It landed 2 days and said "ok".)
 *
 * You cannot tell a gap from an ending by looking at the gap. So we don't try: every
 * year between today and the floor gets asked about. `plugin.hasAnyData` makes that cheap
 * for a source where FETCHING a year is expensive — Gmail counts a day at a time, so a
 * quiet decade costs it ten questions instead of seven thousand.
 *
 * Each chunk merges as it lands, so a long walk is resumable — an interrupted
 * backfill leaves real days in the record, and the next sync picks up from there.
 */
async function backfillPlugin(
  plugin: ImporterPlugin,
  ctx: { credential?: string; fetchImpl?: FetchLike },
  rDir: string,
  instanceId: string,
  to: string,
  progress: (phase: string, pct: number) => void,
): Promise<PluginImportSummary> {
  // RESUME WHERE THE LAST WALK STOPPED. Each chunk merges as it lands, so a twelve-year
  // walk that died on chunk 2 left last year's rows in the record — and "is this a first
  // import?" used to mean "is the record empty?", so the NEXT sync saw those rows,
  // decided the history was already there, fetched the last 7 days and reported ok. The
  // other eleven years were never fetched again by ANY code path. An interrupted
  // backfill looked exactly like a finished one. Now the walk writes down how far it
  // got, so it can be picked up rather than silently abandoned.
  let cursor = readBackfillState(instanceId).cursor ?? to;
  let chunks = 0;
  let earliest = to;
  // The last chunk that HELD data seeds the summary; the rest is accumulated onto it,
  // so the shape stays exactly what a single import returns.
  let merged: PluginImportSummary | null = null;
  let daysWithData = 0;
  let cells = 0;
  let skipped = 0;
  const metrics = new Set<string>();
  const extraSources = new Set<string>();

  // ALL THE WAY DOWN. There is no early exit any more — see the doc above. Every year
  // between today and the floor is asked about, so a silence in the middle of a life
  // cannot be mistaken for the end of one.
  while (cursor > BACKFILL_FLOOR) {
    const from = maxIso(shiftIso(cursor, -(BACKFILL_CHUNK_DAYS - 1)), BACKFILL_FLOOR);
    chunks++;
    progress(`fetching your ${plugin.name} history — ${from.slice(0, 4)}`, Math.min(70, 15 + chunks * 2));

    // A source that is expensive to FETCH (Gmail counts a day at a time — 730 requests
    // a year) can say cheaply whether a year holds anything at all. Ask that first, and
    // a quiet decade costs one request a year instead of seven thousand. A source with
    // no probe just fetches: for those the fetch IS the probe, and it is one request.
    if (plugin.hasAnyData && !(await plugin.hasAnyData({ ...ctx, from, to: cursor }))) {
      skipped++;
      cursor = shiftIso(from, -1);
      writeBackfillState(instanceId, { cursor });
      continue;
    }

    const s = await importPlugin(plugin, { ...ctx, from, to: cursor }, rDir, instanceId);
    if (s.daysWithData > 0) {
      earliest = from;
      daysWithData += s.daysWithData;
      cells += s.cells;
      for (const m of s.metrics) metrics.add(m);
      for (const x of s.extraSources) extraSources.add(x);
      // EVERY chunk's events and text tables, not just the last one's. The summary
      // seeds from the newest chunk that held data, so an older chunk's `_texts` rows
      // and journal events were dropped from the accounting — written to the record,
      // but never inserted into the cache or the search index, so a decade of imported
      // meeting notes was unsearchable until someone happened to run `rebuild`.
      merged = merged
        ? { ...s, appendedEvents: [...merged.appendedEvents, ...s.appendedEvents] }
        : s;
    }
    cursor = shiftIso(from, -1);
    writeBackfillState(instanceId, { cursor });
  }
  // The walk reached the floor: this source's history is now fully in the record, and a
  // later sync can safely resume from the newest day instead of walking again.
  writeBackfillState(instanceId, { cursor: undefined, done: true, at: new Date().toISOString() });

  // Nothing anywhere: report the empty window honestly rather than inventing one.
  if (!merged) return await importPlugin(plugin, { ...ctx, from: earliest, to }, rDir, instanceId);
  return {
    ...merged,
    extraSources: [...extraSources],
    from: earliest,
    to,
    daysWithData,
    cells,
    metrics: [...metrics],
    meta: { ...merged.meta, chunks, quietYearsSkipped: skipped },
  };
}

/** The later of two ISO dates. */
function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * WHERE A SOURCE'S HISTORY BEGINS — asked, never assumed. Walks back a year at a time
 * calling `hasData(from, to)` all the way to the floor, and returns the earliest date
 * that HAD something. It never stops at a quiet stretch — a gap is not an ending.
 *
 * This is the shared spine of every first import (backfillPlugin uses the same
 * constants; WHOOP walks its own cycles the same way). A source that hardcodes a
 * window instead is a source that silently truncates someone's life — GitHub did
 * exactly that, on 90 days, forever.
 */
async function discoverStart(
  hasData: (from: string, to: string) => Promise<boolean>,
  to: string,
  progress: (phase: string, pct: number) => void,
): Promise<string> {
  let cursor = to;
  let chunks = 0;
  let earliest = to;
  // To the floor, with no early exit — a gap is not an ending. See backfillPlugin.
  // `hasData` is one cheap question per year, so asking every year costs nothing worth
  // saving, and stopping early cost people the half of their history that sat behind a
  // quiet spell.
  while (cursor > BACKFILL_FLOOR) {
    const from = maxIso(shiftIso(cursor, -(BACKFILL_CHUNK_DAYS - 1)), BACKFILL_FLOOR);
    chunks++;
    progress(`fetching your {name} history — ${from.slice(0, 4)}`, Math.min(55, 15 + chunks * 2));
    if (await hasData(from, cursor)) earliest = from;
    cursor = shiftIso(from, -1);
  }
  return earliest;
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
    isWhoopInstance(id) || // "whoop" and extra accounts "whoop-2", …
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
  } else if (isWhoopInstance(id)) {
    clearWhoopCreds(cfg, id);
    try {
      fs.rmSync(whoopHrDir(rDir, id), { recursive: true, force: true }); // per-minute HR files
    } catch {
      /* non-fatal */
    }
  } else if (GOOGLE_PRODUCTS.some((p) => p.plugin === id)) {
    // A Google-tree plugin (gcal, gmail) rides ONE shared key. Untick the products
    // it owns; drop the shared grant only when nothing else rides it — removing
    // Calendar must not take Gmail's key, but the last product leaving forgets it
    // (a dangling credential is a lie about connectedness). forgetSourceConfig
    // below clears this plugin's own slots; the shared grant is handled here.
    cfg.googleProducts = googleEnabled(cfg).filter((pid) => googleProductById(pid)?.plugin !== id);
    if (cfg.googleProducts.length === 0 && cfg.sourceOAuth) delete cfg.sourceOAuth.google;
  }
  forgetSourceConfig(cfg, id);
  writeConfig(cfg);
  const dailyRows = rebuild({ recordDir: rDir }).daily;
  return { id, removed: true, dailyRows };
}

/** Wipe what a source LANDED, keep the CONNECTION: drop record/daily/<id>.csv and the
 *  events it wrote, clear only its last-sync stamp, and rebuild. The credential, the
 *  OAuth grant, the schedule, the automation recipe and every saved graph pointing at
 *  it all stay — so the very next `sync <id>` sees an empty record for this source and
 *  re-walks its WHOLE history (syncWindow reads the record, so an empty file IS a first
 *  import) into a clean file.
 *
 *  This is the repair tool for a record poisoned by a bug in an importer, and it exists
 *  because a re-sync alone CANNOT undo one. A sync MERGES into the daily file: it can
 *  raise a value, but it can never delete a row the corrected importer no longer writes
 *  at all. So what survives a re-walk is exactly the invented rows — GitHub's densify()
 *  zeros on days that had no commits, a UTC-bucketed row filed on a day the user did not
 *  live, a count decayed by a recency buffer — and the only way out of them is to start
 *  the file empty.
 *
 *  disconnectSource starts it empty too, but it also forgets the credential: cleaning a
 *  poisoned Google or Strava would have meant re-running the whole OAuth dance just to
 *  drop some bad rows, which is why the damage kept getting fixed by hand instead. Reset
 *  is the same wipe with the key left in. */
export function resetSource(id: string): {
  id: string;
  reset: boolean;
  sources: string[];
  dailyRows: number;
} {
  const rDir = recordDir();
  const bundle = sourceBundleById(id);
  const bundleSourceIds = bundle?.sourceIds(rDir) ?? [];
  const known =
    isAutomation(id) ||
    Boolean(bundle && bundleSourceIds.length) ||
    id === "github" ||
    isWhoopInstance(id) ||
    Boolean(pluginInstanceById(id)) ||
    Boolean(fileImporterById(id)) ||
    hasRecordBackedSource(rDir, id);
  if (!known) {
    throw new Error(
      `Unknown source "${id}". Try a connected source or a record-backed import in record/daily/<source>.csv.`,
    );
  }
  // A bundle (the Google extension scrapes) writes several daily files under one row —
  // resetting the row has to clear all of them, or the re-walk merges into a half-clean
  // record and the poison lives on in the sibling the user never named.
  const ids = bundle && bundleSourceIds.length ? bundleSourceIds : [id];
  for (const sourceId of ids) removeDailySourceFile(rDir, sourceId);
  if (isWhoopInstance(id)) {
    // Per-minute HR is landed data too — leaving it behind would keep a poisoned minute
    // stream beside a freshly re-walked daily table.
    try {
      fs.rmSync(whoopHrDir(rDir, id), { recursive: true, force: true });
    } catch {
      /* non-fatal — nothing to remove */
    }
  }
  const cfg = requireConfig();
  // Clear ONLY the "when did we last run" stamps. They are the one part of the config
  // that describes the data rather than the connection, and after a reset they would be
  // claiming a sync that no longer has anything to show for it.
  for (const sourceId of ids) {
    if (cfg.sourceSyncedAt) delete cfg.sourceSyncedAt[sourceId];
  }
  if (cfg.sourceSyncedAt) delete cfg.sourceSyncedAt[id];
  if (id === "github") delete cfg.githubSyncedAt;
  writeConfig(cfg);
  const dailyRows = rebuild({ recordDir: rDir }).daily;
  return { id, reset: true, sources: ids, dailyRows };
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
  /** whoop only — pull the account's ENTIRE history, whatever the record already
   *  holds. A first import does this on its own; this forces it on an account whose
   *  record was seeded with only a recent slice. */
  allTime?: boolean;
  /** Live phase/percent reporting for the background job bar; optional. */
  onProgress?: JobProgress;
}

/** Land a sync in the cache: patch the rows THIS sync changed, and fall back to a
 *  full rebuild only when there is no cache yet (first import). A sync must never
 *  cost a full re-read of the record — on a large one that blocks the whole server
 *  for minutes, which is how a 50-track Spotify pull took the app down. */
function landSyncInCache(rDir: string, change: SyncCacheChange): number {
  const patched = refreshSyncCache(change, { recordDir: rDir });
  return patched ? patched.dailyRows : rebuild({ recordDir: rDir }).daily;
}

/**
 * The sources a set of saved column-merge rules just REWROTE on disk.
 *
 * `applySavedMerges` runs on every sync and it writes BOTH sides of each rule — it sets
 * cells in the target's CSV and deletes the duplicate column from the source's. But the
 * cache patch only ever named the source being synced, so a SPOTIFY sync could rewrite
 * `health_daily.csv` and `fitbit.csv` on disk and patch neither: the DB kept a
 * `health_daily.steps` column the record no longer had — a ghost metric haunting
 * `query`, the journal and the graphs until someone happened to run `agentqs rebuild`.
 * Whatever a sync touches, a sync patches.
 */
function mergedSources(outcomes: MergeOutcome[]): string[] {
  const out = new Set<string>();
  for (const o of outcomes) {
    for (const ref of [o.from, o.into]) {
      const stem = ref.split(".")[0];
      if (stem) out.add(stem);
    }
  }
  return [...out];
}

/** Run one API source now: fetch → merge → rebuild, persisting the sync time.
 *  `fixture` (a JSON file) drives it offline for GitHub-style ships-when tests. */
export async function syncSource(opts: SyncSourceOpts): Promise<SyncResult> {
  // A backup target is not a source: refuse BEFORE the ledgers, so a stray call
  // can't leave a "failed sync" on something that never syncs.
  if (pluginInstanceById(opts.id)?.plugin.backupTarget) {
    throw new Error(
      `${opts.id} is a backup target, not a data source — run \`agentqs backup drive\` ` +
        '(API: POST /api/backup {"target":"drive"}).',
    );
  }
  if (pluginInstanceById(opts.id)?.plugin.credentialOnly) {
    throw new Error(
      `${opts.id} is read-on-request, not a synced source — run \`agentqs drive pull <file>\` ` +
        "(API: POST /api/drive/pull).",
    );
  }
  // Every attempt lands in the run ledger AND the job ledger — success and failure —
  // so the pipeline report and the Pipeline tab can tell a broken sync from a healthy
  // one, and a later successful scheduler run clears an earlier web failure off the row.
  try {
    const result = await syncSourceInner(opts);
    recordSyncRun(opts.id, true);
    noteSyncOutcome(opts.id, true, undefined, { days: result.days, dailyRows: result.dailyRows });
    return result;
  } catch (e) {
    recordSyncRun(opts.id, false, (e as Error).message);
    noteSyncOutcome(opts.id, false, (e as Error).message);
    throw e;
  }
}

async function syncSourceInner(opts: SyncSourceOpts): Promise<SyncResult> {
  const rDir = recordDir();
  // NO SHARED "LAST 90 DAYS" LIVES HERE ANY MORE. Every branch below asks syncWindow
  // (first import → discover, otherwise → resume from the record), so a new source
  // cannot reach for a trailing default by accident — there isn't one to reach for.
  const cfg = readConfig();
  const now = new Date().toISOString();
  const progress: JobProgress = opts.onProgress ?? (() => {});

  if (opts.id === "github") {
    const token = resolveGithubToken(opts.credential);
    const fetchImpl = opts.fixture ? fixtureFetch(opts.fixture) : undefined;
    if (!token && !fetchImpl && !opts.login) {
      throw new Error("GitHub needs a token — pass --credential or set GITHUB_TOKEN.");
    }
    // THE SAME RULE AS EVERY OTHER SOURCE: a first import discovers its range, a later
    // one resumes. GitHub sat on a flat 90-day window, so years of commit history were
    // never fetched even once — and never would be, because every later sync asked for
    // the same 90 days again.
    const gw = syncWindow(rDir, "github", { days: opts.days });
    const gFrom = gw.firstImport
      ? await discoverStart(
          async (from, to) => {
            const probe = await importGithub({ token, login: opts.login, from, to, recordDir: rDir, fetchImpl });
            return probe.days.some((d) => d.commits > 0);
          },
          gw.to,
          (phase, pct) => progress(phase.replace("{name}", "GitHub"), pct),
        )
      : gw.from;
    progress("fetching commits from GitHub", 60);
    const s = await importGithub({ token, login: opts.login, from: gFrom, to: gw.to, recordDir: rDir, fetchImpl });
    progress("merging into the record", 75);
    const ghMerges = applySavedMerges(rDir); // keep accepted column merges merged on every sync
    progress("updating the cache", 88);
    const dailyRows = landSyncInCache(rDir, { sources: ["github", ...mergedSources(ghMerges)] });
    persistSync("github", opts.credential, now);
    return {
      id: "github", name: "GitHub", from: gFrom, to: gw.to,
      days: s.days.filter((d) => d.commits > 0).length,
      metrics: ["commits"], cells: s.days.length, dailyRows, syncedAt: now,
    };
  }

  if (isWhoopInstance(opts.id)) {
    const instanceId = opts.id;
    let fetchImpl: FetchLike | undefined;
    let creds: WhoopCreds | undefined = whoopCredsFor(cfg, instanceId);
    if (opts.fixture) {
      const data = JSON.parse(fs.readFileSync(opts.fixture, "utf8"));
      fetchImpl = whoopFixtureFetch(data);
      if (!creds?.email) creds = { email: "fixture@whoop", password: "x" };
    }
    if (!fetchImpl && !whoopHasCredential(creds)) {
      throw new Error("WHOOP needs email + password — run 'agentqs whoop connect <email> <password>'.");
    }
    const name = whoopInstanceName(instanceId);
    // What window? Never a blind "last 90 days":
    //   • --days N  → exactly what was asked for.
    //   • record empty (FIRST import) → ALL TIME. A lifetime of data does not
    //     arrive 90 days at a time, and an account that stopped recording before
    //     that window lands nothing at all.
    //   • record has rows → forward from where it left off (with a week of overlap
    //     so late-arriving cycles are picked up), never from today minus 90.
    // WHOOP walks its own history (fetchAllCycles discovers where the account
    // starts), so a first import asks for all-time rather than a backfill window.
    const ww = syncWindow(rDir, instanceId, { days: opts.days });
    const allTime = opts.allTime === true || ww.firstImport;
    progress(
      allTime ? `pulling ${name}: ENTIRE history + per-minute heart rate` : `pulling ${name} days + per-minute heart rate`,
      15,
    );
    const s = await importWhoop({
      creds: creds!,
      from: ww.from,
      to: ww.to,
      recordDir: rDir,
      instanceId,
      fetchImpl,
      allTime,
      hrDays: opts.hrDays && opts.hrDays > 0 ? opts.hrDays : undefined,
    });
    progress("merging into the record", 75);
    const wMerges = applySavedMerges(rDir);
    progress("updating the cache", 88);
    const dailyRows = landSyncInCache(rDir, { sources: [instanceId, ...mergedSources(wMerges)] });
    // The refreshed LOGIN is worth keeping whatever happens next (it is not a claim
    // about data). The SYNC TIMESTAMP is not: it used to be stamped here, before the
    // zero-day check below could throw, so a failed sync left the row reading "last
    // sync: just now" beside its own red error — and `isDue` went false, so an hourly
    // schedule considered itself satisfied by a sync that landed nothing at all.
    const c2 = readConfig();
    if (c2) {
      setWhoopCreds(c2, instanceId, s.creds);
      writeConfig(c2);
    }
    // Landing NOTHING is not success. A silent "ok · 0 days" is exactly how a
    // WHOOP account with no recent data reads as "the source is broken" — say what
    // the account actually holds so the next move is obvious.
    if (s.daysWithData === 0) {
      const backTo = s.latestCycle
        ? Math.ceil((Date.now() - new Date(`${s.latestCycle}T00:00:00Z`).getTime()) / 86_400_000) + 90
        : 0;
      throw new Error(
        s.latestCycle
          ? `${name}: no cycles between ${s.from} and ${s.to}. This account's newest cycle is ${s.latestCycle} — the strap has not recorded since. Pull its history with: agentqs sync ${instanceId} --days ${backTo}`
          : `${name}: WHOOP returned no cycles at all for ${s.from} → ${s.to}. The login worked, so this account holds no data in that window.`,
      );
    }
    // It really synced. NOW it is stamped.
    persistSync(instanceId, undefined, now);
    return {
      id: instanceId, name, from: s.from, to: s.to,
      days: s.daysWithData, metrics: s.metrics, cells: s.cells, dailyRows, syncedAt: now,
    };
  }

  const inst = pluginInstanceById(opts.id);
  if (!inst) {
    throw new Error(`Unknown API source "${opts.id}". Try: github, whoop, ${SOURCE_PLUGINS.map((p) => p.id).join(", ")}`);
  }
  const { plugin, instanceId } = inst;
  // AN UNTICKED PRODUCT REFUSES TO SYNC. The tick says what the one Google key is
  // allowed to bring in, and the ONLY place it was enforced was the `due` flag — so
  // the cron respected it and every other door ignored it. Untick Calendar and
  // `agentqs sync` (no --source) or POST /api/import/gcal would go on pulling your
  // calendar anyway. Gmail happened to refuse on its own ("nothing checked"); Calendar
  // had no such guard, so the rule held for exactly one of the two products it governs.
  // It belongs HERE, in the one place every face goes through.
  if (!googlePluginOn(cfg, plugin.id)) {
    throw new Error(
      `${plugin.name} is switched off under Google on the Pipeline tab, so it will not sync. ` +
        `Tick it there (CLI: agentqs google enable ${plugin.id === "gcal" ? "calendar" : "gmail.inbox"}).`,
    );
  }
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
  const pw = syncWindow(rDir, instanceId, { days: opts.days, backfillDays: plugin.backfillDays });
  // A first import DISCOVERS its range by walking back until the source runs dry —
  // unless the API can't walk (`backfillDays`), in which case one capped window is
  // the most it can ever give and pretending otherwise just burns calls.
  //
  // AN UNFINISHED WALK IS STILL A FIRST IMPORT. Chunks merge as they land, so a walk
  // that died halfway left rows behind — and "first import" meant "the record is empty",
  // so the next sync saw those rows, decided the history was already imported, and
  // topped up the last 7 days. Everything the walk never reached was abandoned in
  // silence. A source is only past its first import once the walk says it FINISHED.
  // (`--days N` is a deliberate top-up and never triggers a walk.)
  const resuming = !opts.days && !pw.firstImport && !readBackfillState(instanceId).done;
  const summary =
    (pw.firstImport || resuming) && !plugin.backfillDays
      ? await backfillPlugin(plugin, { credential, fetchImpl }, rDir, instanceId, pw.to, progress)
      : await (async () => {
          progress(pw.firstImport ? `fetching your ${plugin.name} history` : `fetching your ${plugin.name} data`, 15);
          return importPlugin(plugin, { credential, from: pw.from, to: pw.to, fetchImpl }, rDir, instanceId);
        })();
  // A FIRST IMPORT THAT LANDS NOTHING IS NOT A SUCCESS. A later sync landing zero days
  // is ordinary — nothing new since yesterday. But a source with an EMPTY record that
  // just walked its whole history back to 2000 and came home with nothing has not found
  // a quiet life; something is wrong. A revoked Calendar scope answers `200 {items:[]}`,
  // so every sync landed zero rows, the ledger went green, the row said "synced 2
  // minutes ago", and the calendar quietly stopped recording — for months. Only WHOOP
  // ever threw here; every other source called it ok.
  if (pw.firstImport && summary.daysWithData === 0) {
    throw new Error(
      `${plugin.name} is connected but returned NO data for any date between ${summary.from} and ${summary.to}. ` +
        "That is not an empty history — a working source always has something. Check that the account is the right " +
        "one and that the app still has permission (re-authorize from the Pipeline tab).",
    );
  }
  progress("merging into the record", 75);
  const pMerges = applySavedMerges(rDir);
  progress("updating the cache", 88);
  const dailyRows = landSyncInCache(rDir, {
    sources: [instanceId, ...summary.extraSources, ...mergedSources(pMerges)],
    eventsReplaced: summary.eventsReplaced,
    eventsAdded: summary.appendedEvents,
  });
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
  const candidates = ["github", "whoop", ...SOURCE_PLUGINS.filter((p) => p.live).map((p) => p.id)];
  // EVERY EXTRA ACCOUNT, however it was connected. This used to scan `sourceCreds`
  // only — so a second account connected by the OAUTH DANCE (whose credential lives in
  // `sourceOAuth`, not `sourceCreds`) was never a candidate, and a second WHOOP athlete
  // (`whoopCredsByInstance`) was not either: `pluginInstanceById("whoop-2")` is null,
  // because WHOOP is bespoke rather than a SOURCE_PLUGIN. `agentqs sync` silently never
  // synced them, and did not even list them as skipped — they were invisible. (`sync
  // --due` covered them, via buildSources, so the two entry points disagreed about
  // which accounts exist.)
  const extra = new Set<string>([
    ...Object.keys(cfg?.sourceCreds ?? {}),
    ...Object.keys(cfg?.sourceOAuth ?? {}),
    ...Object.keys(cfg?.whoopCredsByInstance ?? {}),
  ]);
  for (const key of extra) {
    if (candidates.includes(key)) continue;
    if (isWhoopInstance(key)) {
      candidates.push(key);
      continue;
    }
    const inst = pluginInstanceById(key);
    if (inst && inst.plugin.live && !inst.plugin.backupTarget && key !== inst.plugin.id) candidates.push(key);
  }
  for (const id of candidates) {
    const hasCred =
      id === "github"
        ? Boolean(resolveGithubToken())
        : isWhoopInstance(id)
          ? whoopHasCredential(whoopCredsFor(cfg, id))
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
  // A FILE gets read WHOLE. It is finite, it is already on this disk, and there is no
  // API to be polite to — clipping your own Chrome history to the last 90 days just
  // throws away years that were sitting right there. (This used to apply only to
  // "lifetime exports"; a local Chrome/Safari history DB got the 90-day window and
  // silently truncated.) `--days N` still narrows it deliberately.
  // The 90 that used to sit here was only ever read for its `to` (today) — but a
  // trailing constant in a sync path is exactly the shape of the bug that shipped four
  // times, and the next person to touch this would not have known it was inert.
  const narrowed = opts.days && opts.days > 0 ? opts.days : 0;
  const win = windowDays(narrowed || 1);
  const from = narrowed ? win.from : "0001-01-01";
  const summary = await importFile(importer, { path: filePath, from, to: win.to }, rDir);
  // A FILE THAT LANDS NOTHING IS NOT A SUCCESS. A file is finite and sitting on your
  // disk: if we read it whole and got zero days, we did not find an empty life — we
  // failed to read it (wrong file, an export shape we do not parse, a browser DB whose
  // schema moved). Reporting ok here is how a broken importer passes for a working one.
  // (Apple Health already threw on zero records; nothing else did.)
  if (summary.daysWithData === 0) {
    throw new Error(
      `${importer.name}: read ${filePath} but found no data for any date. That is not an empty history — ` +
        "check this is the right file (and the right export format); nothing was written to the record.",
    );
  }
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

/** The live onboarding checklist: every setup step with its exact CLI / MCP /
 *  API call and a `done` flag derived from real state. Agents start here. */
export { onboardingGuide } from "./onboarding";

// ---- off-site backups -----------------------------------------------------------

/** GitHub snapshot branch + encrypted Drive archive + restore. Backups are data
 *  going OUT: neither target is a source, so neither shows up in the pipeline,
 *  and both schedule under `config.backup` (`setBackupInterval`). */
export { backupGithub, backupStatus, setBackupPassphrase, setBackupInterval } from "./backup";

/** A fresh Drive access token from the stored grant — minted per run (the pasted
 *  one dies within hours). Absent grant = not connected, and no backup runs. */
async function driveCredential(): Promise<string> {
  const inst = pluginInstanceById("gdrive_backup");
  const credential = inst
    ? await resolveSyncCredentialFresh(inst.plugin, undefined, readConfig(), inst.instanceId)
    : undefined;
  if (!credential) {
    throw new Error(
      "Google Drive backup isn't connected — Settings → Data → Google Drive, or " +
        "`agentqs source authorize gdrive_backup --client-id <id> --client-secret <secret>`.",
    );
  }
  return credential;
}

/** Run the Drive backup NOW: tar + AES-256-GCM the whole store, upload one
 *  archive, rotate to the newest `keep`. This is a BACKUP, not a sync — it
 *  reads the record and writes nothing back into it (a receipt row would be
 *  bookkeeping masquerading as captured data); the outcome lands in
 *  `config.backup.drive` and reads back from `backupStatus()`. */
export async function backupDrive(): Promise<import("./backup").DriveBackupResult> {
  const { runDriveBackup } = await import("./backup");
  return runDriveBackup({ credential: await driveCredential() });
}

// ---- Google Drive IMPORT (read-on-request) ------------------------------------
//
// The read sibling of the Drive BACKUP above: a folder you fill, read only when a
// question needs it. Nothing lands in the record — these are pure reads, like
// `query`. The brain is src/lib/drive-import.ts; here we just mint a fresh token
// from the `drive_import` grant and call it.

/** A fresh drive.readonly access token from the stored `drive_import` grant.
 *  Absent grant = not connected: no folder can be read. */
async function driveImportCredential(): Promise<string> {
  const inst = pluginInstanceById("drive_import");
  const credential = inst
    ? await resolveSyncCredentialFresh(inst.plugin, undefined, readConfig(), inst.instanceId)
    : undefined;
  if (!credential) {
    throw new Error(
      "Google Drive import isn't connected — Settings → Data → Drive import, or " +
        "`agentqs source authorize drive_import --client-id <id> --client-secret <secret>`.",
    );
  }
  return credential;
}

/** Where the raw-import folder points, and whether the grant is connected — the
 *  panel derives its state from THIS (survives reload), never one-shot UI state. */
export function driveImportStatus() {
  const inst = pluginInstanceById("drive_import");
  const cfg = readConfig();
  const grant = cfg?.sourceOAuth?.["drive_import"];
  const connected = Boolean(grant?.refreshToken || grant?.accessToken);
  const folder = driveImportConfig(cfg);
  return {
    connected,
    folderId: folder.folderId ?? null,
    folderName: folder.folderName ?? null,
    name: inst ? inst.plugin.name : "Google Drive import",
  };
}

/** Point agentqs at a folder to read (id, or "" to clear). */
export function driveFolderSet(folderId: string, folderName?: string) {
  return setDriveImportFolder(folderId, folderName);
}

/** List a Drive folder's files (the manifest). Empty `folderId` lists the account's
 *  top-level folders so the user can find the one to point at; otherwise defaults to
 *  the configured folder. */
export async function driveList(folderId?: string) {
  const target = folderId ?? driveImportConfig().folderId ?? "";
  const token = await driveImportCredential();
  const files = await listDriveFolder(token, target, fetch);
  return { folderId: target || null, count: files.length, files };
}

/** Pull ONE file's content on request. `file` is a Drive file id, or a name /
 *  substring matched within the configured folder. Returns the extracted text (or a
 *  note for binary / oversize files) — nothing is written to the record. */
export async function drivePull(file: string) {
  const token = await driveImportCredential();
  const trimmed = file.trim();
  if (!trimmed) throw new Error("Name a file to pull (id, name, or a unique substring).");
  // A Drive id is a long token with no spaces; try it directly, and fall back to
  // resolving a name within the configured folder.
  const folderId = driveImportConfig().folderId ?? "";
  if (!folderId && !/^[\w-]{20,}$/.test(trimmed)) {
    throw new Error("No folder is set — pass a Drive file id, or set a folder first (Settings → Data → Drive import).");
  }
  if (/^[\w-]{20,}$/.test(trimmed) && !folderId) {
    return pullDriveFile(token, trimmed, fetch);
  }
  const files = await listDriveFolder(token, folderId, fetch);
  const hit = resolveDriveFile(files, trimmed);
  if ("candidates" in hit) {
    const names = hit.candidates.map((c) => c.name).join(", ");
    throw new Error(
      hit.candidates.length
        ? `"${trimmed}" is ambiguous — matches: ${names}. Pass a file id or an exact name.`
        : `No file matching "${trimmed}" in the folder.`,
    );
  }
  return pullDriveFile(token, hit.file.id, fetch, hit.file);
}

/** Decrypt + unpack an archive — into a FRESH directory (`out`), or with
 *  `intoStore` straight into the LIVE store (record replaced + retired beside
 *  it, instance config kept, cache rebuilt — the migration path onto a fresh
 *  instance). Local file or the newest one in Drive (`latest`, needs the
 *  connected gdrive_backup grant). */
export async function backupRestore(opts: {
  file?: string;
  latest?: boolean;
  out?: string;
  passphrase?: string;
  intoStore?: boolean;
}) {
  const { restoreArchive, restoreIntoStore } = await import("./backup");
  const credential = opts.latest ? await driveCredential() : undefined;
  if (opts.intoStore) {
    return restoreIntoStore({ file: opts.file, latest: opts.latest, credential, passphrase: opts.passphrase });
  }
  if (!opts.out) throw new Error("Pass --out <dir> — restores land in a fresh directory (or use --into-store).");
  return restoreArchive({ file: opts.file, latest: opts.latest, credential, out: opts.out, passphrase: opts.passphrase });
}

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

const CONFIG_KEYS = ["provider", "model", "key", "theme", "username", "timezone"] as const;
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
    // The zone the record's days are counted in — this machine's unless overridden.
    timezone: recordTimeZone(cfg),
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
    case "timezone": {
      // The timezone the record's DAYS are counted in. Defaults to this machine's — set
      // it on a hosted instance, whose server clock has nothing to do with where the
      // user lives. A day in the record is a day in someone's life, not a slice of UTC.
      const tz = value.trim();
      if (!tz) {
        delete cfg.timezone; // back to this machine's
        break;
      }
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      } catch {
        throw new Error(`Unknown timezone "${tz}". Use an IANA name, e.g. Asia/Jerusalem or America/New_York.`);
      }
      cfg.timezone = tz;
      break;
    }
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
  // removeSkill hides a built-in (restorable) or drops a custom one; false = nothing
  // by that id. A built-in is never gone for good — say so.
  if (!removeSkill(id)) {
    throw new Error(isBuiltinSkill(id) ? `Built-in persona "${id}" is already hidden.` : `No mentor "${id}".`);
  }
  return { removed: id };
}

/** Un-hide every deleted built-in persona (the CLI/MCP twin of Settings → Restore
 *  defaults). Returns how many came back. */
export function skillsRestoreDefaults(): { restored: number } {
  return { restored: restoreBuiltinSkills() };
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
