import fs from "fs";
import { configPath, dataDir, recordDir } from "./paths";
import type { JournalView } from "./journal";
import type { SavedGraph } from "./graphs";
import { sanitizeSavedGraphs } from "./graphs";
import type { Interval } from "./sources";
import type { Skill } from "./skills";
import type { AutomationCreds, AutomationRecipe } from "./automation-types";
import type { WhoopCreds } from "./importers/whoop";
import { recordInAppRepoApplicable, recordInAppRepoEnabled } from "./record-git";
import { storeSummary, type StoreSummary } from "./store-doctor";
import { whisperInstalled } from "./whisper-local";
import {
  accountBase,
  isProvider,
  resolveLlm,
  type ModelSelection,
  type ProviderAccount,
  type ResolvedLlm,
} from "./models";

/** Embedding model config. Local (all-MiniLM / hash) is the default — no key, no
 *  network. An optional API model + key upgrades fidelity. */
export interface EmbeddingConfig {
  mode: "local" | "api";
  enabled?: boolean; // semantic search on at all (default true)
  autoIndex?: boolean; // rebuild the vector index automatically when the record changes (default true)
  model?: string;
  providerId?: string; // reuse a provider account's key, or…
  apiKey?: string; // …a standalone key
}

/** Voice model config: the live in-chat session backend + its key, plus the
 *  built-in memo transcriber installed from Settings. */
export interface VoiceConfig {
  provider: "" | "elevenlabs" | "google-live";
  providerId?: string; // reuse a provider account's key (Google Live = the Gemini key), or…
  apiKey?: string; // …a standalone key
  agentId?: string; // ElevenLabs agent id
  whisperModel?: string; // built-in local Whisper for memos ("tiny" | "base" | "small"), set on install
  whisperLang?: string; // spoken language for the built-in Whisper (default "en")
}

/** How one channel answers: AI replies (the grounded agent) or log-only capture,
 *  plus an optional persona + model override for that channel. */
export interface ChannelReplyPrefs {
  ai?: boolean; // false → every inbound message lands in the inbox, no LLM
  skill?: string; // persona id the channel replies as
  providerId?: string; // model override for this channel (defaults to the app model)
  model?: string;
}

/** One accepted column merge: values written to `from` fold into `into` on every
 *  future import, the automatic side winning conflicts — so a duplicate column
 *  merged once can never split again. Keys are `source.metric`. */
export interface ColumnMergeRule {
  from: string;
  into: string;
  savedAt: string;
}

/** Channel links set from Settings (fall back to process.env when unset). */
export interface ChannelsConfig {
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
  replies?: Record<string, ChannelReplyPrefs>; // per-channel reply behaviour, keyed by channel id
}

/** An OAuth2 app the user registered with a provider (client id + secret) plus
 *  the tokens the authorize dance minted. A refresh/access token here is a
 *  STORED CREDENTIAL — it makes the source connected, and disconnect deletes it. */
/** The user's registered OAuth application for a provider. Saved ONCE and reused by
 *  every account: registering the app and signing in are separate acts. */
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

export interface OAuthGrant {
  /** Legacy: the app creds used to live on the grant. Still READ (so a grant minted
   *  before `oauthApps` keeps working), never required — new keys are written to
   *  `config.oauthApps[provider]`. */
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string; // ISO — syncs refresh before use once past
  /** Space-separated scopes the grant actually HOLDS (what Google returned, not
   *  what we asked for). Lets the Google card tell "Gmail is ticked but the key
   *  never got the mail scope" from "Gmail is connected". */
  scopes?: string;
}

/** Off-site backups (`agentqs backup`, src/lib/backup.ts). GitHub gets a
 *  size-capped snapshot branch of the plain-text record; Drive gets the WHOLE
 *  store as one AES-256-GCM archive — together they cover every byte. */
export interface GithubBackupConfig {
  remote: string; // https/ssh URL of the PRIVATE backup repo
  branch?: string; // remote branch the snapshot lands on (default "main")
  token?: string; // PAT for https pushes; falls back to githubToken / ambient git auth
  interval?: Interval; // `sync --due` cadence (default daily)
  lastAt?: string;
  lastCommit?: string;
  lastError?: string;
}

export interface DriveBackupConfig {
  folderId?: string; // Drive folder the archives land in (created on first run)
  keep?: number; // archives kept before rotation (default 8)
  /** `sync --due` cadence (default off). A backup is data going OUT, so its
   *  schedule lives HERE, beside GitHub's — never in `sourceIntervals`, which
   *  is the cadence of data coming IN. (Legacy stores kept it under
   *  `sourceIntervals.gdrive_backup`; `backupStatus` still reads that.) */
  interval?: Interval;
  lastAt?: string;
  lastFile?: string;
  lastBytes?: number;
  lastError?: string;
}

export interface BackupConfig {
  github?: GithubBackupConfig;
  drive?: DriveBackupConfig;
  /** Encrypts every Drive archive. Losing it makes existing archives
   *  unreadable — the CLI tells the user to store a copy off this machine. */
  passphrase?: string;
}

/** The in-flight authorize dance (one at a time): the `state` nonce the callback
 *  must echo, and the exact redirect URI the code exchange must repeat. */
export interface OAuthPending {
  state: string;
  instanceId: string;
  redirectUri: string;
  createdAt: string;
}

/**
 * On-disk config, the first thing agentqs writes. Its presence is the "has this
 * instance been set up?" signal that drives the first-run redirect.
 */
export interface AppConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  providers?: ProviderAccount[]; // the AI-providers LIST (label + key + base) added in Settings
  selectedModel?: ModelSelection; // the chat model in use (a provider account + a live model id)
  embedding?: EmbeddingConfig; // embedding model (local default; optional API model + key)
  voice?: VoiceConfig; // live voice session backend + key
  channels?: ChannelsConfig; // Telegram / Slack links
  llmProvider?: string; // legacy single-provider fields (migrated into `providers`)
  llmKey?: string;
  model?: string;
  theme: string; // light | dark | system
  createdAt: string;
  githubToken?: string; // GitHub PAT for the commits importer (optional)
  githubSyncedAt?: string; // ISO timestamp of the last GitHub import
  journalViews?: JournalView[]; // saved Journal table layouts, per user
  savedGraphs?: SavedGraph[]; // saved correlation / timeline graph cards
  sourceIntervals?: Record<string, Interval>; // per-source sync cadence (Pipeline tab)
  sourceCreds?: Record<string, string>; // per-source API key / OAuth token (Tier-1 plugins)
  sourceOAuth?: Record<string, OAuthGrant>; // per-ACCOUNT OAuth grant (the tokens the dance minted)
  /**
   * The user's OAuth APP credentials, per PROVIDER ("google", "spotify") — NOT per
   * account. The app key and the login are two different things with two different
   * lifetimes: you register the app once, then sign in as many times and as many
   * accounts as you like. Keeping the key inside each grant meant re-pasting the
   * client id + secret to add a second account or to simply log back in, which is
   * absurd — the key never changed. Saved once here, every account of that provider
   * rides it.
   */
  oauthApps?: Record<string, OAuthApp>;
  oauthPending?: OAuthPending; // authorize dance in flight (cleared by the callback)
  sourceSyncedAt?: Record<string, string>; // per-source last-sync ISO (Tier-1 plugins)
  customSkills?: Skill[]; // user-authored mentor personas (CLI/API/MCP add-mentor); merged with built-ins
  hiddenSkills?: string[]; // built-in persona ids the user deleted (restorable from Settings)
  automations?: AutomationRecipe[]; // browser-automation import recipes (sources with no API)
  automationCreds?: Record<string, AutomationCreds>; // per-automation secrets, kept out of the recipe
  whoopCreds?: WhoopCreds; // WHOOP unofficial app login (base account): email + password + cached/rotated tokens
  /** Extra WHOOP accounts ("whoop-2", …). The base account stays in `whoopCreds`
   *  for back-compat; a second athlete's login lands here, keyed by instance id,
   *  exactly like a plugin's second account under sourceCreds. */
  whoopCredsByInstance?: Record<string, WhoopCreds>;
  apiKey?: string; // bearer token for the HTTP API over the wire (generated in Connect)
  demoSeeded?: boolean; // generic demo data is loaded; auto-wiped on the first real import
  autoStructure?: boolean; // structure new captures immediately, skipping the pending inbox (default false)
  columnMerges?: ColumnMergeRule[]; // accepted duplicate-column merges, re-applied on every import (column scanner)
  backup?: BackupConfig; // off-site backups: GitHub snapshot branch + encrypted Drive archive
  /** Which Google products are switched on ("calendar", "gmail.inbox", …). One
   *  Google key, a tree of products the user ticks; absent → calendar only (what
   *  "Google" meant before the tree existed). See src/lib/google.ts. */
  googleProducts?: string[];
}

/** Are semantic embeddings on at all? Default true — the Settings checkbox flips it off. */
export function embeddingEnabled(cfg: AppConfig | null): boolean {
  return cfg?.embedding?.enabled !== false;
}

/** Should the vector index rebuild itself when the record changes? Default true;
 *  off = only the manual "Reindex now" button (or CLI) builds it. */
export function autoIndexEnabled(cfg: AppConfig | null): boolean {
  return embeddingEnabled(cfg) && cfg?.embedding?.autoIndex !== false;
}

/** Should a new capture be structured immediately instead of waiting pending? Default false. */
export function autoStructureEnabled(cfg: AppConfig | null): boolean {
  return cfg?.autoStructure === true;
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

export { sanitizeSavedGraphs };

/** Coerce untrusted input into a clean ProviderAccount[] before it hits config.json. */
export function sanitizeProviders(input: unknown): ProviderAccount[] {
  if (!Array.isArray(input)) return [];
  const out: ProviderAccount[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    const type = typeof v.type === "string" && isProvider(v.type) ? v.type : "";
    if (!type) continue;
    const id = typeof v.id === "string" && v.id ? v.id.slice(0, 60) : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type,
      label: (typeof v.label === "string" ? v.label.trim() : "").slice(0, 60),
      apiKey: typeof v.apiKey === "string" ? v.apiKey : "",
      baseUrl: (typeof v.baseUrl === "string" ? v.baseUrl.trim() : "").slice(0, 300),
    });
  }
  return out.slice(0, 20);
}

/** The providers list, back-filling a legacy single-provider config as one account
 *  so old setups keep answering until they re-save. */
export function effectiveProviders(cfg: AppConfig | null): ProviderAccount[] {
  const list = Array.isArray(cfg?.providers) ? cfg!.providers : [];
  if (list.length) return list;
  if (cfg?.llmProvider && cfg?.llmKey) {
    return [
      {
        id: cfg.llmProvider,
        type: cfg.llmProvider,
        label: cfg.llmProvider,
        apiKey: cfg.llmKey,
        baseUrl: "",
      },
    ];
  }
  return [];
}

/** Resolve the key for a secondary feature (embedding / voice): a linked provider
 *  account's key wins (one key, entered once, reused), else the standalone key. */
export function linkedApiKey(cfg: AppConfig | null, providerId?: string, own?: string): string {
  if (providerId) {
    const acct = effectiveProviders(cfg).find((p) => p.id === providerId);
    if (acct?.apiKey) return acct.apiKey;
  }
  return own || "";
}

/** Resolve the active call target (protocol + key + base + model), honouring an
 *  optional per-request override from the chat model chip. Null when no key is set. */
export function activeLlm(
  cfg: AppConfig | null,
  override?: Partial<ModelSelection> | null,
): ResolvedLlm | null {
  const providers = effectiveProviders(cfg);
  const selected =
    cfg?.selectedModel ??
    (cfg?.llmProvider && cfg?.model ? { providerId: cfg.llmProvider, model: cfg.model } : null);
  return resolveLlm(providers, selected, override);
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

function maskTail(s?: string): string {
  const v = s || "";
  return v ? `••••••••${v.slice(-4)}` : "";
}

/** One provider account as the client sees it — never the raw key. */
export interface PublicProvider {
  id: string;
  type: string;
  label: string;
  baseUrl: string;
  hasKey: string; // masked tail, or ""
}

/** Safe projection for the client — no password hash, no raw keys. */
export interface PublicConfig {
  username: string;
  providers: PublicProvider[];
  selectedModel: ModelSelection | null;
  embedding: {
    mode: "local" | "api";
    enabled: boolean;
    autoIndex: boolean;
    model: string;
    hasKey: boolean;
    providerId: string;
  };
  autoStructure: boolean;
  voice: {
    provider: string;
    hasKey: boolean;
    agentId: string;
    providerId: string;
    whisperModel: string;
    whisperLang: string;
  };
  channels: {
    telegram: boolean;
    slack: boolean;
    slackVerified: boolean; // signing secret stored — inbound events are signature-checked
    replies: Record<string, ChannelReplyPrefs>;
  };
  theme: string;
  dataDir: string;
  recordDir: string;
  recordInAppRepo: boolean;
  recordInAppRepoApplicable: boolean;
  store: StoreSummary;
  createdAt: string;
}

export function publicConfig(cfg: AppConfig): PublicConfig {
  const providers = effectiveProviders(cfg).map((p) => ({
    id: p.id,
    type: p.type,
    label: p.label || p.type,
    baseUrl: accountBase(p),
    hasKey: maskTail(p.apiKey),
  }));
  const emb = cfg.embedding;
  const voice = cfg.voice;
  const whisperModel = voice?.whisperModel && whisperInstalled(voice.whisperModel) ? voice.whisperModel : "";
  const ch = cfg.channels;
  const selectedModel =
    cfg.selectedModel ??
    (cfg.llmProvider && cfg.model ? { providerId: cfg.llmProvider, model: cfg.model } : null);
  return {
    username: cfg.username,
    providers,
    selectedModel,
    embedding: {
      mode: emb?.mode === "api" ? "api" : "local",
      enabled: embeddingEnabled(cfg),
      // The RAW stored flag, not autoIndexEnabled() — the settings form round-trips
      // this value, and the derived (enabled && autoIndex) would persist a false
      // the user never chose after toggling embeddings off and back on.
      autoIndex: emb?.autoIndex !== false,
      model: emb?.model || "",
      hasKey: Boolean(linkedApiKey(cfg, emb?.providerId, emb?.apiKey)),
      providerId: emb?.providerId || "",
    },
    autoStructure: autoStructureEnabled(cfg),
    voice: {
      provider: voice?.provider || "",
      hasKey: Boolean(linkedApiKey(cfg, voice?.providerId, voice?.apiKey)),
      agentId: voice?.agentId || "",
      providerId: voice?.providerId || "",
      whisperModel,
      whisperLang: voice?.whisperLang || "en",
    },
    channels: {
      telegram: Boolean(ch?.telegramBotToken),
      slack: Boolean(ch?.slackBotToken),
      slackVerified: Boolean(ch?.slackSigningSecret),
      replies: ch?.replies ?? {},
    },
    theme: cfg.theme,
    dataDir: dataDir(),
    recordDir: recordDir(),
    recordInAppRepo: recordInAppRepoEnabled(),
    recordInAppRepoApplicable: recordInAppRepoApplicable(),
    store: storeSummary(),
    createdAt: cfg.createdAt,
  };
}
