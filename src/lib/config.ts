import fs from "fs";
import { configPath, dataDir } from "./paths";
import type { JournalView } from "./journal";
import type { Interval } from "./sources";
import type { Skill } from "./skills";
import type { AutomationCreds, AutomationRecipe } from "./automation-types";
import type { WhoopCreds } from "./importers/whoop";
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
  model?: string;
  providerId?: string; // reuse a provider account's key, or…
  apiKey?: string; // …a standalone key
}

/** Voice model config: the live in-chat session backend + its key. */
export interface VoiceConfig {
  provider: "" | "elevenlabs" | "google-live";
  apiKey?: string;
  agentId?: string; // ElevenLabs agent id
}

/** Channel links set from Settings (fall back to process.env when unset). */
export interface ChannelsConfig {
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  slackBotToken?: string;
  slackSigningSecret?: string;
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
  sourceIntervals?: Record<string, Interval>; // per-source sync cadence (Data tab)
  sourceCreds?: Record<string, string>; // per-source API key / OAuth token (Tier-1 plugins)
  sourceSyncedAt?: Record<string, string>; // per-source last-sync ISO (Tier-1 plugins)
  customSkills?: Skill[]; // user-authored mentor personas (CLI/API/MCP add-mentor); merged with built-ins
  automations?: AutomationRecipe[]; // browser-automation import recipes (sources with no API)
  automationCreds?: Record<string, AutomationCreds>; // per-automation secrets, kept out of the recipe
  whoopCreds?: WhoopCreds; // WHOOP unofficial app login: email + password + cached/rotated tokens
  apiKey?: string; // bearer token for the HTTP API over the wire (generated in Connect)
  demoSeeded?: boolean; // generic demo data is loaded; auto-wiped on the first real import
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
  embedding: { mode: "local" | "api"; model: string; hasKey: boolean };
  voice: { provider: string; hasKey: boolean; agentId: string };
  channels: { telegram: boolean; slack: boolean };
  theme: string;
  dataDir: string;
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
      model: emb?.model || "",
      hasKey: Boolean(emb?.apiKey),
    },
    voice: {
      provider: voice?.provider || "",
      hasKey: Boolean(voice?.apiKey),
      agentId: voice?.agentId || "",
    },
    channels: {
      telegram: Boolean(ch?.telegramBotToken),
      slack: Boolean(ch?.slackBotToken),
    },
    theme: cfg.theme,
    dataDir: dataDir(),
    createdAt: cfg.createdAt,
  };
}

// protocolOf re-export kept for call sites that resolve a raw account type.
export { protocolOf };
