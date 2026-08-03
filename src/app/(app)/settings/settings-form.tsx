"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme-provider";
import {
  AudioLines,
  Check,
  Code,
  Copy,
  Cpu,
  Data as DataIcon,
  Eye,
  EyeOff,
  GitHub,
  GoogleDrive,
  Key,
  Mic,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Slack,
  Sliders,
  Sparkles,
  Spinner,
  Sun,
  Table,
  Telegram,
  Terminal,
  Trash,
  User,
  Wand,
} from "@/components/icons";
import { CRON_CMD, CliRow, CopyRow, KeyRow, PH, SYNC_CMD, fixPromptSnip, mcpSnip, skillSnip } from "@/components/connect-api";
import { Badge, Button, Card, Checkbox, Field, Input, Select, Switch, cn } from "@/components/ui";
import { API_CATALOG } from "@/lib/api-catalog";
import { PROVIDER_TYPES, defaultBaseFor, providerTypeOf } from "@/lib/models";
import { ago } from "@/lib/sources";
import { SKILLS, type Skill } from "@/lib/skills";
import type { ChannelReplyPrefs, PublicConfig } from "@/lib/config";

interface EmbedStatus {
  built: boolean;
  count: number;
  stale: boolean;
  model: string;
  backend: "sqlite-vec" | "js-cosine" | null;
  modelId: string;
}

/** One built-in Whisper model as /api/voice/whisper reports it. */
interface WhisperModelRow {
  id: string;
  size: string;
  hint: string;
  installed: boolean;
}

/** GET /api/backup — the off-site backup panel's whole state. */
interface BackupView {
  github: {
    configured: boolean;
    remote?: string;
    branch?: string;
    interval: string;
    lastAt: string | null;
    lastError?: string;
  };
  drive: {
    connected: boolean;
    passphraseSet: boolean;
    interval: string;
    lastAt: string | null;
    lastFile?: string;
    lastError?: string;
  };
  /** The Drive upload runs as a background job (minutes, survives a reload) —
   *  this is its live phase, polled from the same GET. */
  driveJob: { status: string; phase: string; pct: number; error?: string } | null;
}

interface WhisperStatus {
  active: string; // the model memos use, "" when none
  lang: string;
  models: WhisperModelRow[];
}

/** What will transcribe a memo right now (from the mic capability probe). */
interface SttCap {
  ready: boolean;
  backend: string | null;
  label: string;
}

/** Whisper is multilingual but can't auto-detect (yet) — the memo language is a
 *  setting. Token → label, the common ones; Whisper accepts ~100. */
const WHISPER_LANGS: [string, string][] = [
  ["en", "English"],
  ["he", "Hebrew"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
];

/** One editable provider account row in the list. */
interface ProviderRow {
  id: string;
  type: string;
  label: string;
  baseUrl: string;
  hasKey: string; // masked existing key
  key: string; // new key (blank = keep existing)
  models: string[]; // live list loaded from /api/models
  loading: boolean;
  err: string;
}

let rid = 0;
const newId = (type: string) => `${type}-${Date.now().toString(36)}-${(rid++).toString(36)}`;

type IconComponent = (p: React.SVGProps<SVGSVGElement>) => JSX.Element;

/** Settings subtabs. Deep links use the hash (/settings#skills, /settings#api);
 *  legacy anchors that aren't tab ids (#memos) map to their tab below. */
const TABS: { id: string; label: string; icon: IconComponent }[] = [
  { id: "general", label: "General", icon: Sliders },
  { id: "models", label: "Models", icon: Sparkles },
  { id: "voice", label: "Voice", icon: Mic },
  { id: "channels", label: "Channels", icon: Send },
  { id: "agent", label: "Agent", icon: Cpu },
  { id: "skills", label: "Skills", icon: Wand },
  { id: "data", label: "Data", icon: DataIcon },
  { id: "api", label: "API", icon: Key },
];

const HASH_TABS: Record<string, string> = { memos: "voice" };

/** What GET /api/channels/<id> answers: is the bot wired up, AND is the platform
 *  actually delivering to it. The second half is what a silent bot needs. */
interface ChannelProbe {
  enabled?: boolean;
  verified?: boolean;
  verdict?: { tone: "ok" | "warn" | "error"; text: string } | null;
  deliveries?: { last?: { at: string; outcome: string; detail?: string } } | null;
}

function tabForHash(hash: string): string | null {
  if (TABS.some((t) => t.id === hash)) return hash;
  return HASH_TABS[hash] ?? null;
}

/** One settings topic: icon chip + title + description over an always-open body.
 *  `action` renders on the right of the header (status pills, quick buttons). */
/**
 * Every IANA zone the runtime knows. `Intl.supportedValuesOf` is the browser's own list,
 * so it stays right as the world's timezones change; the fallback is only for a runtime
 * old enough not to have it, and still covers the zones people actually live in.
 */
const TIMEZONES: string[] = (() => {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (supported) return supported("timeZone");
  } catch {
    /* fall through */
  }
  return [
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Asia/Jerusalem",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
  ];
})();

function Section({
  id,
  title,
  desc,
  icon: Icon,
  action,
  children,
}: {
  id?: string;
  title: string;
  desc?: string;
  icon?: IconComponent;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        {Icon ? (
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon width={15} height={15} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {desc ? <p className="mt-0.5 text-[13px] leading-snug text-muted-fg">{desc}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

export function SettingsForm({ config }: { config: PublicConfig }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  // Active subtab, synced with the URL hash so deep links + back/forward work.
  const [tab, setTab] = useState("general");
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.slice(1);
      const target = tabForHash(hash);
      if (!target) return;
      setTab(target);
      // Legacy section anchors (#memos) also scroll to their card inside the tab.
      if (target !== hash) {
        window.setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  function goTab(id: string) {
    setTab(id);
    window.history.replaceState(null, "", `#${id}`);
  }

  const [username, setUsername] = useState(config.username);
  // "" = follow this machine's clock. On a hosted instance that is the SERVER's clock,
  // which is why this is worth showing rather than hiding behind a CLI flag.
  const [timezone, setTimezone] = useState(config.timezone);
  const [password, setPassword] = useState("");

  // Providers LIST — add many; each is label + key + base over a known type.
  const [providers, setProviders] = useState<ProviderRow[]>(
    config.providers.map((p) => ({
      id: p.id,
      type: p.type,
      label: p.label,
      baseUrl: p.baseUrl,
      hasKey: p.hasKey,
      key: "",
      models: [],
      loading: false,
      err: "",
    })),
  );
  const [sel, setSel] = useState(config.selectedModel);

  // Embedding / Voice / Channels. Embedding + Google voice ride the SAME APIs as
  // the AI providers, so their key defaults to a linked provider account ("" = own key).
  const [embMode, setEmbMode] = useState<"local" | "api">(config.embedding.mode);
  const [embEnabled, setEmbEnabled] = useState(config.embedding.enabled);
  const [embAutoIndex, setEmbAutoIndex] = useState(config.embedding.autoIndex);
  const [embModel, setEmbModel] = useState(config.embedding.model);
  const [embKey, setEmbKey] = useState("");
  const [embProviderId, setEmbProviderId] = useState(config.embedding.providerId);
  // Structure: auto-drain new captures into the daily table (skip the pending inbox).
  const [autoStructure, setAutoStructure] = useState(config.autoStructure);
  const [recordInAppRepo, setRecordInAppRepo] = useState(config.recordInAppRepo);
  const [recordPrivateConfirmed, setRecordPrivateConfirmed] = useState(config.recordInAppRepo);
  const [migrating, setMigrating] = useState(false);
  const [migrateMsg, setMigrateMsg] = useState("");
  // Off-site backups (Data tab) — state lives on GET /api/backup, refetched quietly.
  const [backup, setBackup] = useState<BackupView | null>(null);
  const [backupMsg, setBackupMsg] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [ghRemote, setGhRemote] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [ghSetupOpen, setGhSetupOpen] = useState(false);
  const [driveSetupOpen, setDriveSetupOpen] = useState(false);
  const [driveClientId, setDriveClientId] = useState("");
  const [driveClientSecret, setDriveClientSecret] = useState("");
  // Drive IMPORT (read-on-request) — its own drive.readonly grant + a folder to read.
  const [driveImp, setDriveImp] = useState<{
    connected: boolean;
    folderId: string | null;
    folderName: string | null;
  } | null>(null);
  const [driveImpMsg, setDriveImpMsg] = useState("");
  const [driveImpBusy, setDriveImpBusy] = useState(false);
  const [driveImpClientId, setDriveImpClientId] = useState("");
  const [driveImpClientSecret, setDriveImpClientSecret] = useState("");
  const [driveImpFolder, setDriveImpFolder] = useState("");
  const [driveImpFolderName, setDriveImpFolderName] = useState("");
  const ghOn = Boolean(backup?.github.configured) && backup?.github.interval !== "off";
  const driveOn = Boolean(backup?.drive.connected) && backup?.drive.interval !== "off";
  const [voiceProvider, setVoiceProvider] = useState(config.voice.provider);
  const [voiceKey, setVoiceKey] = useState("");
  const [voiceProviderId, setVoiceProviderId] = useState(config.voice.providerId);
  const [voiceAgent, setVoiceAgent] = useState(config.voice.agentId);

  // Voice memos — the built-in local Whisper (install state + language).
  const [whisper, setWhisper] = useState<WhisperStatus | null>(null);
  const [whisperSel, setWhisperSel] = useState(config.voice.whisperModel || "base");
  const [whisperLang, setWhisperLang] = useState(config.voice.whisperLang || "en");
  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperErr, setWhisperErr] = useState("");
  const [stt, setStt] = useState<SttCap | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [slackToken, setSlackToken] = useState("");
  const [slackSecret, setSlackSecret] = useState("");
  // The conversation the app POLLS on its own schedule, as well as receiving pushes.
  const [slackPull, setSlackPull] = useState(config.channels.slackPullChannel ?? "");
  /**
   * The LIVE state of each bot, from its own capability probe — the truth the
   * webhook itself runs on. The server-rendered config only knows what's in
   * config.json, so a bot credentialed by env var (SLACK_BOT_TOKEN on a hosted
   * instance) worked perfectly while this page called it "Not linked". Probe wins;
   * config is the fallback until it answers.
   */
  const [channelLive, setChannelLive] = useState<Record<string, ChannelProbe>>({});
  const loadChannels = useCallback(async () => {
    const probes = await Promise.all(
      ["slack", "telegram"].map(async (id) => {
        try {
          const res = await fetch(`/api/channels/${id}`, { cache: "no-store" });
          if (!res.ok) return null;
          const s = (await res.json()) as ChannelProbe;
          return [
            id,
            {
              enabled: Boolean(s.enabled),
              verified: Boolean(s.verified),
              // Inbound health travels with the probe: a token can be perfect while
              // the platform has stopped calling, or while every call is refused.
              verdict: s.verdict ?? null,
              deliveries: s.deliveries ?? null,
            },
          ] as const;
        } catch {
          return null; // a failed probe must never downgrade a working bot to "Not linked"
        }
      }),
    );
    const live = probes.filter((p): p is NonNullable<typeof p> => p !== null);
    if (live.length) setChannelLive((prev) => ({ ...prev, ...Object.fromEntries(live) }));
  }, []);
  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);
  // Per-channel reply behaviour: AI replies vs log-only, persona, model override.
  const [replies, setReplies] = useState<Record<string, ChannelReplyPrefs>>({
    telegram: { ai: true, ...config.channels.replies.telegram },
    slack: { ai: true, ...config.channels.replies.slack },
  });
  const [origin, setOrigin] = useState("");
  // Slack's create-from-manifest path sets the scopes, the events AND the request
  // URL in one paste — the click-by-click alternative is where people get lost
  // hunting a bot token that does not exist until the app is installed.
  const slackWebhook = `${origin || "https://<your-host>"}/api/channels/slack`;
  const slackManifest = [
    "display_information:",
    "  name: agentqs",
    "features:",
    "  bot_user:",
    "    display_name: agentqs",
    "  app_home:",
    "    messages_tab_enabled: true",
    // Without this Slack BLOCKS every DM to the bot ("sending messages is turned
    // off") — it is off by default and there is no hint of it in the DM itself.
    "    messages_tab_read_only_enabled: false",
    "oauth_config:",
    "  scopes:",
    "    bot:",
    "      - chat:write",
    "      - im:history",
    "      - app_mentions:read",
    // Channel capture: public needs channels:*, private needs groups:*. Slack does
    // NOT auto-add these when you subscribe to the matching message event.
    "      - channels:history",
    "      - channels:join",
    "      - groups:history",
    "settings:",
    "  event_subscriptions:",
    `    request_url: ${slackWebhook}`,
    "    bot_events:",
    "      - message.im",
    "      - app_mention",
    "      - message.channels",
    "      - message.groups",
  ].join("\n");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  const loadBackup = () =>
    fetch("/api/backup")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: BackupView | null) => {
        if (!d) return;
        setBackup(d);
        setGhRemote((v) => v || d.github.remote || "");
      })
      .catch(() => {});
  useEffect(() => {
    void loadBackup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive-import status (connected + folder) lives on GET /api/drive; refetched
  // quietly after an action so the panel derives from the record, not one-shot state.
  const loadDriveImport = () =>
    fetch("/api/drive")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { connected: boolean; folderId: string | null; folderName: string | null } | null) => {
        if (!d) return;
        setDriveImp(d);
        setDriveImpFolder((v) => v || d.folderId || "");
        setDriveImpFolderName((v) => v || d.folderName || "");
      })
      .catch(() => {});
  useEffect(() => {
    void loadDriveImport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start the read-only OAuth dance for Drive import (its own drive.readonly grant). */
  async function connectDriveImport() {
    setDriveImpBusy(true);
    setDriveImpMsg("");
    try {
      const res = await fetch("/api/oauth/drive_import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: driveImpClientId.trim(),
          clientSecret: driveImpClientSecret.trim(),
          origin: window.location.origin,
        }),
      });
      const r = await res.json();
      if (!res.ok || !r.authorizeUrl) {
        setDriveImpMsg(r.error || "Could not start the Google authorization.");
        return;
      }
      window.location.href = r.authorizeUrl;
    } catch {
      setDriveImpMsg("Could not start the Google authorization.");
    } finally {
      setDriveImpBusy(false);
    }
  }

  /** Point agentqs at a folder to read (or clear it with an empty id). */
  async function saveDriveFolder() {
    setDriveImpBusy(true);
    setDriveImpMsg("");
    try {
      const res = await fetch("/api/drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: driveImpFolder.trim(), folderName: driveImpFolderName.trim() || undefined }),
      });
      const r = await res.json();
      if (!res.ok) {
        setDriveImpMsg(r.error || "Could not save the folder.");
        return;
      }
      setDriveImpMsg(driveImpFolder.trim() ? "Folder set." : "Folder cleared.");
      void loadDriveImport();
    } catch {
      setDriveImpMsg("Could not save the folder.");
    } finally {
      setDriveImpBusy(false);
    }
  }

  // A running Drive upload is polled quietly (never a loading flag — the panel
  // the user is in must not unmount), so the row shows its phase live and lands
  // on the finished archive even if the page was reopened mid-upload.
  const driveRunning = backup?.driveJob?.status === "running" || backup?.driveJob?.status === "queued";
  useEffect(() => {
    if (!driveRunning) return;
    const t = window.setInterval(() => void loadBackup(), 2500);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveRunning]);

  /** Every target speaks to /api/backup — a backup is not a source import.
   *  GitHub pushes synchronously (fast); Drive answers 202 with a background
   *  job (encrypt + upload takes minutes and must survive a reload), whose
   *  progress the poll below reads back from the same GET. */
  async function runBackup(target: "github" | "drive" | "passphrase") {
    setBackupBusy(true);
    setBackupMsg("");
    try {
      const body =
        target === "github"
          ? { target, remote: ghRemote.trim() || undefined, token: ghToken.trim() || undefined }
          : target === "passphrase"
            ? { target, generate: true }
            : { target };
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await res.json();
      if (!res.ok) setBackupMsg(r.error || "Backup failed.");
      else if (target === "passphrase") {
        setBackupMsg(`Passphrase: ${r.generated} — copy it somewhere safe NOW; it is never shown again.`);
      } else if (target === "drive") {
        setBackupMsg("Encrypting and uploading — this keeps running if you leave the page.");
      } else setBackupMsg(r.message || "Pushed.");
      if (target === "github") {
        setGhToken("");
        if (res.ok) setGhSetupOpen(false);
      }
      await loadBackup();
    } catch {
      setBackupMsg("Backup failed — try the CLI: agentqs backup status");
    } finally {
      setBackupBusy(false);
    }
  }

  /** The GitHub switch: unconfigured → reveal the one-time setup; configured →
   *  pause/resume the daily schedule (a resume with no push yet pushes now). */
  async function toggleGithub(on: boolean) {
    setBackupMsg("");
    if (!backup?.github.configured) {
      setGhSetupOpen(on);
      return;
    }
    setBackupBusy(true);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "github", schedule: on ? "daily" : "off" }),
      });
      if (!res.ok) setBackupMsg((await res.json()).error || "Failed.");
      await loadBackup();
    } catch {
      setBackupMsg("Failed — try the CLI: agentqs backup github --schedule daily");
    } finally {
      setBackupBusy(false);
    }
    if (on && !backup.github.lastAt) await runBackup("github");
  }

  /** The Drive switch: unconnected → reveal the one-time OAuth setup;
   *  connected → pause/resume the BACKUP schedule (it lives under config.backup
   *  beside GitHub's — Drive is a backup target, not a source). Resuming with no
   *  passphrase generates one first (shown once). */
  async function toggleDrive(on: boolean) {
    setBackupMsg("");
    if (!backup?.drive.connected) {
      setDriveSetupOpen(on);
      return;
    }
    if (on && !backup.drive.passphraseSet) await runBackup("passphrase");
    setBackupBusy(true);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "drive", schedule: on ? "daily" : "off" }),
      });
      if (!res.ok) setBackupMsg((await res.json()).error || "Failed.");
      await loadBackup();
    } catch {
      setBackupMsg("Failed — try the CLI: agentqs backup drive --schedule daily");
    } finally {
      setBackupBusy(false);
    }
    // First time on with no archive yet: start one now (background job).
    if (on && backup.drive.passphraseSet && !backup.drive.lastAt) await runBackup("drive");
  }

  /** Drive one-time setup: make sure the passphrase exists BEFORE the first
   *  archive (shown once in an alert), then start the standard OAuth dance. */
  async function connectDrive() {
    setBackupBusy(true);
    setBackupMsg("");
    try {
      if (backup && !backup.drive.passphraseSet) {
        const pr = await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "passphrase", generate: true }),
        });
        const pj = await pr.json();
        if (pr.ok && pj.generated) {
          window.alert(
            `Your backup passphrase — copy it somewhere safe NOW, it is never shown again:\n\n${pj.generated}\n\nEvery Drive archive is unreadable without it.`,
          );
        }
      }
      const res = await fetch("/api/oauth/gdrive_backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: driveClientId.trim(),
          clientSecret: driveClientSecret.trim(),
          origin: window.location.origin,
        }),
      });
      const r = await res.json();
      if (!res.ok || !r.authorizeUrl) {
        setBackupMsg(r.error || "Could not start the Google authorization.");
        return;
      }
      window.location.href = r.authorizeUrl;
    } catch {
      setBackupMsg("Could not start the Google authorization.");
    } finally {
      setBackupBusy(false);
    }
  }

  function patchReplies(channel: string, up: Partial<ChannelReplyPrefs>) {
    setReplies((r) => ({ ...r, [channel]: { ...r[channel], ...up } }));
  }

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);

  // Skills = built-ins + any added here or from the CLI / MCP / API.
  const [skills, setSkills] = useState<(Skill & { builtin: boolean })[]>(
    SKILLS.map((s) => ({ ...s, builtin: true })),
  );
  const [newName, setNewName] = useState("");
  const [newSystem, setNewSystem] = useState("");
  const [addingSkill, setAddingSkill] = useState(false);
  const [skillErr, setSkillErr] = useState("");

  function patchRow(id: string, up: Partial<ProviderRow>) {
    setProviders((rows) => rows.map((r) => (r.id === id ? { ...r, ...up } : r)));
  }

  function addProvider() {
    const type = "anthropic";
    setProviders((rows) => [
      ...rows,
      { id: newId(type), type, label: "", baseUrl: defaultBaseFor(type), hasKey: "", key: "", models: [], loading: false, err: "" },
    ]);
  }

  function removeProvider(id: string) {
    setProviders((rows) => rows.filter((r) => r.id !== id));
    setSel((s) => (s?.providerId === id ? null : s));
  }

  /** Load a provider's live model list from its own /models endpoint. */
  async function loadModels(row: ProviderRow) {
    patchRow(row.id, { loading: true, err: "" });
    const body = row.key
      ? { type: row.type, key: row.key, base: row.baseUrl }
      : row.hasKey
        ? { providerId: row.id }
        : { type: row.type, key: "", base: row.baseUrl };
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        patchRow(row.id, { loading: false, err: d.error || "Could not load models." });
        return;
      }
      patchRow(row.id, { loading: false, models: Array.isArray(d.models) ? d.models : [] });
    } catch {
      patchRow(row.id, { loading: false, err: "Could not reach the provider." });
    }
  }

  async function refreshSkills() {
    const d = await fetch("/api/skills").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d && Array.isArray(d.skills)) setSkills(d.skills);
  }

  async function addSkill() {
    setSkillErr("");
    if (newName.trim().length < 2 || newSystem.trim().length < 10) {
      setSkillErr("Give a name and a system prompt (10+ chars).");
      return;
    }
    setAddingSkill(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), system: newSystem.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSkillErr(d.error || "Could not add skill.");
        return;
      }
      setNewName("");
      setNewSystem("");
      await refreshSkills();
    } finally {
      setAddingSkill(false);
    }
  }

  async function removeSkill(id: string) {
    await fetch(`/api/skills?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    await refreshSkills();
  }

  /** Bring back the default personas the user deleted (they're hidden, never lost). */
  async function restoreDefaultSkills() {
    await fetch("/api/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ restoreDefaults: true }),
    }).catch(() => {});
    await refreshSkills();
  }

  useEffect(() => {
    let alive = true;
    fetch("/api/embeddings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setEmbed(d as EmbedStatus))
      .catch(() => {});
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && Array.isArray(d.skills) && setSkills(d.skills))
      .catch(() => {});
    fetch("/api/voice/whisper")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setWhisper(d as WhisperStatus);
        if (d.active) setWhisperSel(d.active);
      })
      .catch(() => {});
    fetch("/api/voice/memo")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setStt(d as SttCap))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** Install (download once) or switch to a built-in Whisper model, then refresh
   *  what the mic will actually use. Remove deletes the weights from disk. */
  async function whisperAction(method: "POST" | "DELETE") {
    setWhisperBusy(true);
    setWhisperErr("");
    try {
      const res = await fetch(
        method === "POST" ? "/api/voice/whisper" : `/api/voice/whisper?model=${encodeURIComponent(whisperSel)}`,
        method === "POST"
          ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: whisperSel }) }
          : { method },
      );
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setWhisperErr(d.error || "That didn't work — try again.");
        return;
      }
      setWhisper(d as WhisperStatus);
      const cap = await fetch("/api/voice/memo").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (cap) setStt(cap as SttCap);
    } catch {
      setWhisperErr("Could not reach the server.");
    } finally {
      setWhisperBusy(false);
    }
  }

  async function reindex() {
    setReindexing(true);
    try {
      const res = await fetch("/api/embeddings", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setEmbed((e) => ({
          built: true,
          count: d.count ?? 0,
          stale: false,
          model: d.model ?? e?.model ?? "",
          backend: d.backend ?? e?.backend ?? null,
          modelId: d.model ?? e?.modelId ?? "",
        }));
      }
    } finally {
      setReindexing(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);

    const body: Record<string, unknown> = {
      username: username.trim(),
      timezone: timezone.trim(),
      theme,
      providers: providers.map((p) => ({
        id: p.id,
        type: p.type,
        label: p.label.trim(),
        apiKey: p.key, // blank = keep stored
        baseUrl: p.baseUrl.trim(),
      })),
      selectedModel: sel ?? null,
      embedding: {
        mode: embMode,
        enabled: embEnabled,
        autoIndex: embAutoIndex,
        model: embModel,
        providerId: embProviderId,
        ...(embKey ? { apiKey: embKey } : {}),
      },
      autoStructure,
      recordInAppRepo,
      recordInAppRepoPrivateConfirmed: recordPrivateConfirmed,
      voice: {
        provider: voiceProvider,
        providerId: voiceProviderId,
        agentId: voiceAgent,
        whisperLang,
        ...(voiceKey ? { apiKey: voiceKey } : {}),
      },
      channels: {
        ...(tgToken ? { telegramBotToken: tgToken } : {}),
        ...(slackToken ? { slackBotToken: slackToken } : {}),
        ...(slackSecret ? { slackSigningSecret: slackSecret } : {}),
        slackPullChannel: slackPull.trim(),
        replies,
      },
    };
    if (password) body.password = password;

    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Could not save settings.");
      return;
    }
    setSaved(true);
    setPassword("");
    setEmbKey("");
    setVoiceKey("");
    setTgToken("");
    setSlackToken("");
    setSlackSecret("");
    setTimeout(() => setSaved(false), 2000);
    // Re-probe the bots: a token saved just now must flip the badge to Linked
    // here and then, not on the user's next full page load.
    void loadChannels();
    router.refresh();
  }

  // A provider account is a valid model source once it has a key (saved or typed).
  const keyedProviders = providers.filter((p) => p.hasKey || p.key);
  const selRow = providers.find((p) => p.id === sel?.providerId);

  return (
    <form onSubmit={save} className="md:grid md:grid-cols-[190px_1fr] md:items-start md:gap-8 lg:grid-cols-[210px_1fr] lg:gap-10">
      {/* Submenu — vertical rail on desktop, scrollable pills on mobile */}
      <nav
        aria-label="Settings sections"
        className="scrollbar-none -mx-1 mb-4 flex gap-1 overflow-x-auto px-1 md:sticky md:top-4 md:mx-0 md:mb-0 md:block md:space-y-1 md:overflow-visible md:px-0"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => goTab(t.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors md:w-full",
                active ? "bg-accent/10 text-fg" : "text-muted-fg hover:bg-muted hover:text-fg",
              )}
            >
              <t.icon width={15} height={15} className={cn("shrink-0", active && "text-accent")} />
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 space-y-3">
      {tab === "general" ? (
      <>
      {/* Profile */}
      <Section title="Profile" icon={User} desc="Login email, password, and the timezone your days are counted in.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="username">
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="New password" htmlFor="password">
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
          {/*
            A day in your record is a day in your LIFE, not a slice of UTC. Get this
            wrong and your 9pm lands on tomorrow — and every correlation over those days
            compares the wrong ones. It matters most exactly where it is least visible:
            a hosted instance follows the SERVER's clock, which has nothing to do with
            where you live.
          */}
          <Field
            label="Timezone"
            htmlFor="timezone"
            hint={
              timezone
                ? "The day an evening play, check-in or meeting is filed under."
                : `Following this machine — currently ${config.timezoneResolved}. On a hosted instance that is the server's clock, not yours.`
            }
          >
            <Select id="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="">Automatic ({config.timezoneResolved})</option>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      {/* Appearance */}
      <Section title="Appearance" icon={Sun} desc="Theme for the whole app.">
        <div className="grid max-w-xs grid-cols-2 gap-2">
          {(["light", "dark"] as const).map((t) => {
            const active = theme === t;
            const Icon = t === "light" ? Sun : Moon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTheme(t)}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium capitalize transition-colors",
                  active ? "border-accent bg-accent/10 text-fg" : "border-border bg-card text-muted-fg hover:bg-muted hover:text-fg",
                )}
              >
                <Icon width={16} height={16} />
                {t}
                {active ? <Check width={14} height={14} className="text-accent" /> : null}
              </button>
            );
          })}
        </div>
      </Section>
      </>
      ) : null}

      {tab === "models" ? (
      <>
      {/* AI providers list */}
      <Section title="AI providers" icon={Sparkles} desc="API accounts that power chat. Add as many as you like, then pick the default model.">
        <div className="space-y-3">
          {providers.length === 0 ? (
            <p className="text-sm text-muted-fg">No providers added.</p>
          ) : (
            providers.map((row) => (
              <ProviderCard
                key={row.id}
                row={row}
                onChange={(up) => patchRow(row.id, up)}
                onLoad={() => void loadModels(row)}
                onRemove={() => removeProvider(row.id)}
              />
            ))
          )}
          <Button type="button" size="sm" onClick={addProvider}>
            <Plus width={14} height={14} /> Add provider
          </Button>
        </div>

        {/* Default chat model */}
        <div className="mt-5 border-t border-border pt-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Default model — provider">
              <Select
                value={selRow ? selRow.id : ""}
                onChange={(e) => setSel(e.target.value ? { providerId: e.target.value, model: "" } : null)}
              >
                <option value="">None</option>
                {keyedProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || providerTypeOf(p.type)?.label || p.type}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default model — id">
              <Select
                value={selRow ? (sel?.model ?? "") : ""}
                disabled={!selRow}
                onChange={(e) => sel && setSel({ providerId: sel.providerId, model: e.target.value })}
              >
                {selRow?.models.length ? (
                  selRow.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                ) : (
                  <option value={selRow ? (sel?.model ?? "") : ""}>
                    {selRow ? sel?.model || "Load models on the provider" : "Pick a provider first"}
                  </option>
                )}
              </Select>
            </Field>
          </div>
        </div>
      </Section>

      {/* Embedding model */}
      <Section title="Embedding model" icon={Cpu} desc="Powers semantic search over your journal. Local runs on-device.">
        <div className="grid max-w-xs grid-cols-2 gap-2">
          {(["local", "api"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setEmbMode(m)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors",
                embMode === m ? "border-accent bg-accent/10 text-fg" : "border-border bg-card text-muted-fg hover:bg-muted",
              )}
            >
              {m === "local" ? "Local" : "API"}
            </button>
          ))}
        </div>
        {embMode === "local" ? (
          <p className="mt-3 text-xs text-muted-fg">
            all-MiniLM, on-device. No key, no network. Stored in <code className="font-mono">{config.dataDir}</code>.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Model">
              <Input value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder="text-embedding-3-small" />
            </Field>
            <Field label="Key" hint="Embeddings use the same API as your AI providers — reuse that key.">
              <Select value={embProviderId} onChange={(e) => setEmbProviderId(e.target.value)}>
                <option value="">Separate key…</option>
                {keyedProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    Use {p.label || providerTypeOf(p.type)?.label || p.type} key
                  </option>
                ))}
              </Select>
            </Field>
            {!embProviderId ? (
              <Field label="API key" hint={config.embedding.hasKey ? "A key is saved. Enter a new one to replace it." : undefined}>
                <Input type="password" value={embKey} onChange={(e) => setEmbKey(e.target.value)} placeholder="key" className="font-mono" />
              </Field>
            ) : null}
          </div>
        )}
      </Section>

      {/* Semantic search (embeddings) */}
      <Section title="Semantic search" icon={Search} desc="The vector index over your entries. Reindex after big imports.">
        <div className="space-y-3">
          <Checkbox
            label="Embed entries for semantic search"
            hint="On by default — the local model runs on-device, no key. Off = no vectors; chat recall and search fall back to keywords."
            checked={embEnabled}
            onChange={setEmbEnabled}
          />
          <Checkbox
            label="Auto-index"
            hint="Rebuild the index automatically whenever new entries land. Off = only the Reindex button updates it."
            checked={embAutoIndex}
            onChange={setEmbAutoIndex}
            disabled={!embEnabled}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-sm">
            <span className={cn("inline-flex h-2 w-2 rounded-full", embed?.built ? "bg-accent" : "bg-muted-fg/50")} />
            <span className="text-fg">
              {embed
                ? embed.built
                  ? `${embed.count} ${embed.count === 1 ? "entry" : "entries"} indexed`
                  : "Not indexed yet"
                : "Checking…"}
            </span>
            {embed?.stale && embed.built ? (
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">out of date</span>
            ) : null}
          </div>
          <Button type="button" size="sm" onClick={() => void reindex()} disabled={reindexing || !embEnabled}>
            {reindexing ? <Spinner width={14} height={14} /> : <Sparkles width={14} height={14} />}
            {reindexing ? "Reindexing…" : "Reindex now"}
          </Button>
        </div>
      </Section>
      </>
      ) : null}

      {tab === "voice" ? (
      <>
      {/* Voice model */}
      <Section title="Voice model" icon={AudioLines} desc="Speech provider for voice sessions.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <Select
              value={voiceProvider}
              onChange={(e) => {
                const p = e.target.value as typeof voiceProvider;
                setVoiceProvider(p);
                if (p !== "google-live") setVoiceProviderId(""); // linked keys are Google-only
              }}
            >
              <option value="">None</option>
              <option value="elevenlabs">ElevenLabs</option>
              <option value="google-live">Google Live</option>
            </Select>
          </Field>
          {voiceProvider === "google-live" ? (
            <Field label="Key" hint="Google Live uses the same Gemini API — reuse your Google provider key.">
              <Select value={voiceProviderId} onChange={(e) => setVoiceProviderId(e.target.value)}>
                <option value="">Separate key…</option>
                {keyedProviders
                  .filter((p) => p.type === "google")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      Use {p.label || providerTypeOf(p.type)?.label || p.type} key
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}
          {voiceProvider && !voiceProviderId ? (
            <Field label="API key" hint={config.voice.hasKey ? "A key is saved. Enter a new one to replace it." : undefined}>
              <Input type="password" value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)} placeholder="key" className="font-mono" />
            </Field>
          ) : null}
          {voiceProvider === "elevenlabs" ? (
            <Field label="Agent id">
              <Input value={voiceAgent} onChange={(e) => setVoiceAgent(e.target.value)} placeholder="agent_…" className="font-mono" />
            </Field>
          ) : null}
        </div>
      </Section>

      {/* Voice memos — the built-in local Whisper for the top-bar mic */}
      <Section
        id="memos"
        title="Voice memos"
        icon={Mic}
        desc="How the top-bar mic transcribes. Install Whisper into the app for private, offline transcription — no key, no cloud, audio never leaves this machine."
      >
        <div className="space-y-4">
          {/* What will transcribe a memo right now */}
          <div className="flex items-center gap-2 text-sm">
            <span className={cn("inline-flex h-2 w-2 shrink-0 rounded-full", stt?.ready ? "bg-accent" : "bg-muted-fg/50")} />
            <span className="text-fg">{stt ? (stt.ready ? stt.label : "No transcriber configured") : "Checking…"}</span>
          </div>

          {/* Model picker — one download, cached in data/models like the embedder */}
          {whisper ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {whisper.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setWhisperSel(m.id)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    whisperSel === m.id ? "border-accent bg-accent/10" : "border-border bg-card hover:bg-muted",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium capitalize text-fg">
                    {m.id}
                    {whisper.active === m.id ? <Check width={13} height={13} className="text-accent" /> : null}
                  </span>
                  <span className="block text-[11px] text-muted-fg">
                    {m.size} · {m.hint}
                    {m.installed && whisper.active !== m.id ? " · installed" : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-fg">Checking installed models…</p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {whisper?.active === whisperSel && whisper?.active ? (
              <Button type="button" size="sm" onClick={() => void whisperAction("DELETE")} disabled={whisperBusy}>
                {whisperBusy ? <Spinner width={14} height={14} /> : <Trash width={14} height={14} />}
                {whisperBusy ? "Removing…" : "Remove"}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => void whisperAction("POST")} disabled={whisperBusy || !whisper}>
                {whisperBusy ? <Spinner width={14} height={14} /> : <Sparkles width={14} height={14} />}
                {whisperBusy
                  ? "Downloading…"
                  : whisper?.models.find((m) => m.id === whisperSel)?.installed
                    ? `Use ${whisperSel}`
                    : `Install ${whisperSel} (${whisper?.models.find((m) => m.id === whisperSel)?.size ?? ""})`}
              </Button>
            )}
            {whisperErr ? <span className="text-xs text-destructive">{whisperErr}</span> : null}
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field label="Spoken language" hint="Whisper can't auto-detect yet — tell it what you speak. Saved with the form.">
              <Select value={whisperLang} onChange={(e) => setWhisperLang(e.target.value)}>
                {WHISPER_LANGS.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <p className="text-xs text-muted-fg">
            The model downloads once into <code className="font-mono">data/models</code> and runs on-device.{" "}
            <code className="font-mono">WHISPER_BIN</code> (your own engine) still takes priority. No install? The
            voice provider above (ElevenLabs / Google Live) transcribes memos with its key; an OpenAI or Google
            provider key stays the fallback.
          </p>
        </div>
      </Section>

      </>
      ) : null}

      {tab === "channels" ? (
      <>
      {/* Channels — one section per platform, same brain as the chat */}
      <ChannelCard
        name="Telegram"
        icon={Telegram}
        desc="DM your bot to chat with your record — “// a note” logs a memo with zero tokens."
        linked={channelLive.telegram?.enabled ?? config.channels.telegram}
        verdict={channelLive.telegram?.verdict ?? null}
        lastDeliveryAt={channelLive.telegram?.deliveries?.last?.at ?? null}
        lastDeliveryOutcome={channelLive.telegram?.deliveries?.last?.outcome ?? null}
        token={tgToken}
        onToken={setTgToken}
        tokenPlaceholder="123456:ABC…"
        webhook={`${origin || "https://<your-host>"}/api/channels/telegram`}
        steps={[
          "Message @BotFather in Telegram → /newbot → copy the bot token.",
          "Paste the token below and save.",
          "Register the webhook: open https://api.telegram.org/bot<TOKEN>/setWebhook?url=<webhook URL> once in your browser.",
          "DM your bot. Plain text chats with your record; “// a note” logs a memo with zero tokens.",
        ]}
        prefs={replies.telegram}
        onPrefs={(up) => patchReplies("telegram", up)}
        skills={skills}
        providers={keyedProviders.map((p) => ({ id: p.id, label: p.label || providerTypeOf(p.type)?.label || p.type }))}
      />
      <ChannelCard
        name="Slack"
        icon={Slack}
        desc="DM or @mention the bot to chat with your record — “// a note” logs a memo with zero tokens."
        linked={channelLive.slack?.enabled ?? config.channels.slack}
        verdict={channelLive.slack?.verdict ?? null}
        lastDeliveryAt={channelLive.slack?.deliveries?.last?.at ?? null}
        lastDeliveryOutcome={channelLive.slack?.deliveries?.last?.outcome ?? null}
        token={slackToken}
        onToken={setSlackToken}
        tokenPlaceholder="xoxb-…"
        webhook={slackWebhook}
        secret={slackSecret}
        onSecret={setSlackSecret}
        secretSet={channelLive.slack?.verified ?? config.channels.slackVerified}
        pullChannel={slackPull}
        onPullChannel={setSlackPull}
        manifest={slackManifest}
        steps={[
          "api.slack.com/apps → Create New App → From a manifest → pick your workspace → paste the manifest below. It sets the scopes, the events and this webhook URL in one go.",
          "Install to Workspace → Allow. The xoxb- token is BORN here: it only appears after installing, on OAuth & Permissions as “Bot User OAuth Token”. It is not the xoxp- user token, not the Verification Token, not the App-Level (xapp-) token.",
          "Paste that xoxb- token below, plus the Signing Secret from Basic Information → App Credentials. Save.",
          "DM the bot (Slack → Apps → agentqs) or @mention it in a channel. Plain text chats with your record; “// a note” logs a memo.",
          "To capture a whole channel (a daily log): invite the bot with /invite @agentqs — a bot can join a public channel itself, but a PRIVATE one only by invite. Set Replies to “Log only” below and every line posted there becomes a capture, zero tokens.",
        ]}
        prefs={replies.slack}
        onPrefs={(up) => patchReplies("slack", up)}
        skills={skills}
        providers={keyedProviders.map((p) => ({ id: p.id, label: p.label || providerTypeOf(p.type)?.label || p.type }))}
      />
      <NotificationsPanel tzResolved={config.timezoneResolved} />
      </>
      ) : null}

      {tab === "agent" ? <RulesPanel tzResolved={config.timezoneResolved} /> : null}

      {tab === "data" ? (
      <>
      {/* Data */}
      <Section title="Data" icon={DataIcon} desc="Where your data lives, and where it syncs to.">
        <Field label="Data directory">
          <div className="flex items-center gap-2">
            <div
              className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[13px] text-fg"
              title={`Everything lives here — the plain-text journal record (record/), config, caches. Override with AGENTQS_DATA_DIR (a restart applies it). Record folder: ${config.recordDir}`}
            >
              {config.dataDir}
            </div>
            <Badge
              tone={config.store.safe ? "accent" : "warning"}
              title={config.store.issues.join("\n") || "Outside every sync engine's reach."}
            >
              {config.store.safe ? "Safe" : "Synced folder"}
            </Badge>
          </div>
        </Field>
        <div className="mt-2 flex items-center gap-2">
          {config.store.issues.length > 0 ? (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-fg" title={config.store.issues.join("\n")}>
              {config.store.issues[0]}
            </span>
          ) : null}
          {!config.store.atDefault && !config.store.envPinned ? (
            <Button
              variant="ghost"
              className="shrink-0"
              title={`Copy the whole store to ${config.store.safeDir}, verify every file, retire the old copy and re-point schedulers. Restart the app afterwards.`}
              disabled={migrating}
              onClick={async () => {
                if (!window.confirm(`Move the store to ${config.store.safeDir}? The app needs a restart afterwards.`)) return;
                setMigrating(true);
                setMigrateMsg("");
                try {
                  const res = await fetch("/api/store/migrate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                  const r = await res.json();
                  setMigrateMsg(res.ok ? `Moved ${r.files} files to ${r.to} — restart the app to finish.` : r.error || "Migration failed.");
                } catch {
                  setMigrateMsg("Migration failed — run `agentqs migrate-store` in a terminal.");
                } finally {
                  setMigrating(false);
                }
              }}
            >
              {migrating ? <Spinner width={13} height={13} /> : null} Move to safe location
            </Button>
          ) : null}
        </div>
        {migrateMsg ? <p className="mt-2 text-xs text-muted-fg">{migrateMsg}</p> : null}
        {config.recordInAppRepoApplicable || recordInAppRepo ? (
          /* Also shown when tracking is ON but the store moved away — the
             checkbox is the only disable control and must stay reachable. */
          <div className="mt-4 border-t border-border pt-4">
            <Checkbox
              label="Allow this repo to track data/record"
              hint="Only enable this if this GitHub repository is private. When off, /data stays ignored and accidental pushes will not include your record."
              checked={recordInAppRepo}
              onChange={(checked) => {
                if (!checked) {
                  setRecordInAppRepo(false);
                  setRecordPrivateConfirmed(false);
                  return;
                }
                const ok = window.confirm(
                  "Warning: data/record contains your personal journal record. Only enable this if this GitHub repository is private. If this repo is public, your data can be pushed publicly. Continue?",
                );
                setRecordInAppRepo(ok);
                setRecordPrivateConfirmed(ok);
              }}
            />
          </div>
        ) : null}
        <div className="mt-4 border-t border-border pt-4">
          <Field label="Sync to">
            <div className="divide-y divide-border rounded-lg border border-border">
              <div className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <GitHub width={18} height={18} className="shrink-0 text-fg" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">GitHub</p>
                    <p
                      className="truncate text-xs text-muted-fg"
                      title={backup?.github.lastError || backup?.github.remote || ""}
                    >
                      {backup?.github.configured
                        ? backup.github.lastError
                          ? `error — ${backup.github.lastError}`
                          : ghOn
                            ? `private repo · backed up ${ago(backup.github.lastAt)}`
                            : "paused"
                        : "your plain-text record, in a private repo"}
                    </p>
                  </div>
                  <Switch
                    checked={ghOn || (ghSetupOpen && !backup?.github.configured)}
                    disabled={backupBusy || !backup}
                    aria-label="Sync to GitHub"
                    title="Daily snapshot of the record, pushed to your private repo."
                    onChange={(on) => void toggleGithub(on)}
                  />
                </div>
                {ghSetupOpen && !backup?.github.configured ? (
                  <div className="mt-2.5 flex items-center gap-2">
                    <Input
                      value={ghRemote}
                      onChange={(e) => setGhRemote(e.target.value)}
                      placeholder="https://github.com/you/record-backup.git (private)"
                      className="min-w-0 flex-1"
                    />
                    <Input
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      placeholder="Token"
                      title="A GitHub token (PAT) with repo access — needed where no git login exists (a hosted instance)."
                      className="w-32 shrink-0"
                    />
                    <Button
                      variant="ghost"
                      className="shrink-0"
                      disabled={backupBusy || !ghRemote.trim()}
                      title="Saves the repo and pushes the first snapshot."
                      onClick={() => void runBackup("github")}
                    >
                      Turn on
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <GoogleDrive width={18} height={18} className="shrink-0 text-fg" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">Google Drive</p>
                    <p
                      className="truncate text-xs text-muted-fg"
                      title={backup?.drive.lastError || backup?.drive.lastFile || ""}
                    >
                      {driveRunning
                        ? `${backup?.driveJob?.phase ?? "uploading"} · ${backup?.driveJob?.pct ?? 0}%`
                        : backup?.drive.connected
                          ? backup.drive.lastError
                            ? `error — ${backup.drive.lastError}`
                            : driveOn
                              ? `encrypted archive · ${backup.drive.lastFile ? `uploaded ${ago(backup.drive.lastAt)}` : "first upload pending"}`
                              : "paused"
                          : "everything, as one encrypted archive"}
                    </p>
                  </div>
                  <Switch
                    checked={driveOn || (driveSetupOpen && !backup?.drive.connected)}
                    disabled={backupBusy || !backup}
                    aria-label="Sync to Google Drive"
                    title="Daily encrypted archive of the whole store, uploaded to your Drive."
                    onChange={(on) => void toggleDrive(on)}
                  />
                </div>
                {driveSetupOpen && !backup?.drive.connected ? (
                  <div className="mt-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={driveClientId}
                        onChange={(e) => setDriveClientId(e.target.value)}
                        placeholder="Google OAuth Client ID"
                        className="min-w-0 flex-1"
                      />
                      <Input
                        value={driveClientSecret}
                        onChange={(e) => setDriveClientSecret(e.target.value)}
                        type="password"
                        placeholder="Client Secret"
                        className="w-36 shrink-0"
                      />
                      <Button
                        variant="ghost"
                        className="shrink-0"
                        disabled={backupBusy || !driveClientId.trim() || !driveClientSecret.trim()}
                        title="Create both at console.cloud.google.com/apis/credentials (enable the Google Drive API, add yourself as a test user, Web application client with the redirect URI below)."
                        onClick={() => void connectDrive()}
                      >
                        Authorize
                      </Button>
                    </div>
                    <CopyRow label={`Redirect URI: ${origin}/api/oauth/callback`} code={`${origin}/api/oauth/callback`} />
                  </div>
                ) : null}
              </div>
            </div>
            {backupMsg ? <p className="mt-2 text-xs text-muted-fg">{backupMsg}</p> : null}
          </Field>
        </div>
      </Section>

      {/* Drive import — read raw files on request (NOT a synced source) */}
      <Section
        title="Drive import"
        icon={GoogleDrive}
        desc="Read raw files (emails, messages, exports) from a Google Drive folder ON REQUEST. Nothing is synced into the record — agentqs reads a file only when a question needs it. Read-only access, its own grant."
      >
        <Field label="Folder">
          <div className="rounded-lg border border-border">
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                <GoogleDrive width={18} height={18} className="shrink-0 text-fg" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">Google Drive (read-on-request)</p>
                  <p className="truncate text-xs text-muted-fg">
                    {driveImp?.connected
                      ? driveImp.folderId
                        ? `reading ${driveImp.folderName || driveImp.folderId}`
                        : "connected — pick a folder below"
                      : "not connected — authorize read-only access"}
                  </p>
                </div>
              </div>
              {driveImp?.connected ? (
                <div className="mt-2.5 flex items-center gap-2">
                  <Input
                    value={driveImpFolder}
                    onChange={(e) => setDriveImpFolder(e.target.value)}
                    placeholder="Drive folder ID"
                    className="min-w-0 flex-1"
                    title="The folder's Drive ID (from its URL: drive.google.com/drive/folders/<ID>). agentqs lists and pulls files from here."
                  />
                  <Input
                    value={driveImpFolderName}
                    onChange={(e) => setDriveImpFolderName(e.target.value)}
                    placeholder="Label (optional)"
                    className="w-36 shrink-0"
                  />
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    disabled={driveImpBusy}
                    onClick={() => void saveDriveFolder()}
                  >
                    {driveImpFolder.trim() ? "Save" : "Clear"}
                  </Button>
                </div>
              ) : (
                <div className="mt-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={driveImpClientId}
                      onChange={(e) => setDriveImpClientId(e.target.value)}
                      placeholder="Google OAuth Client ID"
                      className="min-w-0 flex-1"
                    />
                    <Input
                      value={driveImpClientSecret}
                      onChange={(e) => setDriveImpClientSecret(e.target.value)}
                      type="password"
                      placeholder="Client Secret"
                      className="w-36 shrink-0"
                    />
                    <Button
                      variant="ghost"
                      className="shrink-0"
                      disabled={driveImpBusy || !driveImpClientId.trim() || !driveImpClientSecret.trim()}
                      title="Reuse the same Google project as Drive backup — just add the drive.readonly scope on the consent screen. Read-only: nothing is written to your Drive."
                      onClick={() => void connectDriveImport()}
                    >
                      Authorize
                    </Button>
                  </div>
                  <CopyRow label={`Redirect URI: ${origin}/api/oauth/callback`} code={`${origin}/api/oauth/callback`} />
                </div>
              )}
            </div>
          </div>
          {driveImpMsg ? <p className="mt-2 text-xs text-muted-fg">{driveImpMsg}</p> : null}
        </Field>
      </Section>

      {/* Structure (the pending inbox) */}
      <Section
        title="Structure"
        icon={Table}
        desc="How new captures — memos, voice notes, dropped files, channel messages — become daily rows."
      >
        <Checkbox
          label="Auto-structure new captures"
          hint="Skips the pending inbox: each capture merges straight into your daily table. Prose uses your AI model; off = review and press Structure yourself."
          checked={autoStructure}
          onChange={setAutoStructure}
        />
      </Section>

      </>
      ) : null}

      {tab === "skills" ? (
      <>
      {/* Skills */}
      <Section id="skills" title="Skills" icon={Wand} desc="Personas for chat — switch with /skill <id>. Any skill can be deleted; defaults are restorable.">
        <div className="space-y-2">
          {skills.map((s) => (
            <div key={s.id} className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-fg/50" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {s.name} <span className="font-mono text-xs text-muted-fg">/skill {s.id}</span>
                </p>
                <p className="text-xs text-muted-fg">{s.blurb}</p>
              </div>
              <button
                type="button"
                onClick={() => void removeSkill(s.id)}
                className="shrink-0 rounded p-1 text-muted-fg hover:text-destructive"
                aria-label={`Remove ${s.name}`}
              >
                <Trash width={15} height={15} />
              </button>
            </div>
          ))}
          {SKILLS.some((b) => !skills.some((s) => s.id === b.id)) ? (
            <button
              type="button"
              onClick={() => void restoreDefaultSkills()}
              className="text-xs font-medium text-muted-fg underline decoration-border underline-offset-2 hover:text-fg"
            >
              Restore default skills
            </button>
          ) : null}
        </div>

        <div className="mt-4 space-y-2 rounded-lg border border-border p-3">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" />
          <textarea
            value={newSystem}
            onChange={(e) => setNewSystem(e.target.value)}
            rows={3}
            placeholder="System prompt"
            className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg outline-none placeholder:text-muted-fg/70 focus:border-ring/60"
          />
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={() => void addSkill()} disabled={addingSkill}>
              {addingSkill ? <Spinner width={14} height={14} /> : <Plus width={14} height={14} />}
              Add skill
            </Button>
            {skillErr ? <span className="text-xs text-destructive">{skillErr}</span> : null}
          </div>
        </div>
      </Section>

      </>
      ) : null}

      {tab === "api" ? <ApiTab /> : null}

      {/* Save bar — Skills and API act instantly, everything else saves as one form */}
      {tab !== "api" && tab !== "skills" ? (
        <div className="sticky bottom-0 z-10 border-t border-border bg-bg/90 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? <Spinner width={16} height={16} /> : null}
              {saving ? "Saving…" : "Save changes"}
            </Button>
            {saved ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-accent">
                <Check width={16} height={16} /> Saved
              </span>
            ) : null}
            {error ? <span className="text-sm text-destructive">{error}</span> : null}
          </div>
        </div>
      ) : null}
      </div>
    </form>
  );
}

/** Core HTTP endpoints — the ONE catalog, shared with the `GET /api` discovery
 *  manifest so the human doc and the agent-facing manifest never drift. */
const ENDPOINTS = API_CATALOG;

/**
 * API tab: mint / rotate / revoke the instance bearer key and show how to call
 * the HTTP API — the same key the CLI, the MCP server, and agent skills use.
 * Everything here talks to /api/keys directly; nothing goes through the form save.
 */
function ApiTab() {
  const [base, setBase] = useState("http://localhost:3000");
  const [hasKey, setHasKey] = useState(false);
  const [masked, setMasked] = useState("");
  const [fullKey, setFullKey] = useState("");
  const [busy, setBusy] = useState(false);
  const key = fullKey || masked || PH;

  useEffect(() => {
    if (typeof window !== "undefined") setBase(window.location.origin);
    let alive = true;
    fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        setHasKey(Boolean(d.hasKey));
        setMasked(d.masked || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function generate() {
    setBusy(true);
    try {
      const d = await fetch("/api/keys", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
      if (d.key) {
        setFullKey(d.key);
        setMasked(d.masked || "");
        setHasKey(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke the API key? Every CLI, MCP, and skill using it stops working until you generate a new one.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/keys", { method: "DELETE" });
      if (r.ok) {
        setHasKey(false);
        setMasked("");
        setFullKey("");
      }
    } finally {
      setBusy(false);
    }
  }

  const curl = `curl -s ${base}/api/chat -H "authorization: Bearer ${key}" -H "content-type: application/json" -d '{"message":"How was last week?"}'`;

  return (
    <>
      <Section
        title="API key"
        icon={Key}
        desc="One bearer key authenticates the HTTP API, the CLI, and the MCP server. Rotating it replaces the old key everywhere."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn("inline-flex h-2 w-2 shrink-0 rounded-full", hasKey ? "bg-accent" : "bg-muted-fg/50")} />
            <span className="text-fg">{hasKey ? "Key active" : "No key yet"}</span>
            {masked ? <code className="font-mono text-xs text-muted-fg">{masked}</code> : null}
          </div>
          {fullKey ? (
            <>
              <KeyRow value={fullKey} />
              <p className="text-xs text-muted-fg">Copy it now — the full key is shown only once.</p>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="primary" onClick={() => void generate()} disabled={busy}>
              {busy ? <Spinner width={14} height={14} /> : <Key width={14} height={14} />}
              {hasKey ? "Regenerate key" : "Generate key"}
            </Button>
            {hasKey ? (
              <Button type="button" size="sm" variant="danger" onClick={() => void revoke()} disabled={busy}>
                <Trash width={14} height={14} /> Revoke
              </Button>
            ) : null}
          </div>
        </div>
      </Section>

      <Section
        title="Connect"
        icon={Terminal}
        desc="Ready-made snippets with your key filled in — sync from the CLI, add the MCP server, drop in the agent skill, or hand an AI the data-quality fix prompt."
      >
        <div className="space-y-2">
          <CliRow code={SYNC_CMD} />
          <CliRow code={CRON_CMD} title="Crontab line — auto-runs every source whose interval says it's due, browser scrapes included" />
          <div className="flex gap-2">
            <CopyRow label="Copy mcp" code={mcpSnip(base, key)} className="flex-1" />
            <CopyRow label="Copy skill" code={skillSnip(base, key)} className="flex-1" />
            <CopyRow label="Copy fix prompt" code={fixPromptSnip(base, key)} className="flex-1" />
          </div>
          <p className="text-xs text-muted-fg">
            or work directly in your forked repo — the record is plain files in your own git repo.
          </p>
        </div>
      </Section>

      <Section
        title="Endpoints"
        icon={Code}
        desc="Send the key as an authorization: Bearer header with every call."
      >
        <div className="space-y-3">
          <div className="scrollbar-thin overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <tbody>
                {ENDPOINTS.map((e) => (
                  <tr key={e.method + e.path} className="border-b border-border last:border-0">
                    <td className="py-2.5 pl-3 pr-2 align-top">
                      <span className="inline-flex rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-fg">
                        {e.method}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 align-top">
                      <code className="font-mono text-[12px] text-fg">{e.path}</code>
                      {e.body ? <code className="ml-2 font-mono text-[11px] text-muted-fg">{e.body}</code> : null}
                    </td>
                    <td className="w-full px-3 py-2.5 align-top text-[13px] text-muted-fg">{e.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CliRow code={curl} />
        </div>
      </Section>
    </>
  );
}

/** One provider account: type + label + key + base, with a live model loader. */
function ProviderCard({
  row,
  onChange,
  onLoad,
  onRemove,
}: {
  row: ProviderRow;
  onChange: (up: Partial<ProviderRow>) => void;
  onLoad: () => void;
  onRemove: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const t = providerTypeOf(row.type);
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Select
          value={row.type}
          onChange={(e) => {
            const type = e.target.value;
            onChange({ type, baseUrl: row.baseUrl && row.baseUrl !== defaultBaseFor(row.type) ? row.baseUrl : defaultBaseFor(type), models: [] });
          }}
          className="w-40 shrink-0"
        >
          {PROVIDER_TYPES.map((p) => (
            <option key={p.type} value={p.type}>
              {p.label}
            </option>
          ))}
        </Select>
        <Input value={row.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="Label" className="flex-1" />
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded p-1.5 text-muted-fg hover:text-destructive"
          aria-label="Remove provider"
        >
          <Trash width={15} height={15} />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={row.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder={row.hasKey ? row.hasKey : t?.keyHint || "key"}
            autoComplete="off"
            className="pr-10 font-mono"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-fg hover:text-fg"
            aria-label={showKey ? "Hide key" : "Show key"}
          >
            {showKey ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
          </button>
        </div>
        <Input value={row.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="Base URL" className="font-mono" />
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={onLoad} disabled={row.loading}>
          {row.loading ? <Spinner width={14} height={14} /> : <RefreshCw width={14} height={14} />}
          Load models
        </Button>
        {row.models.length ? (
          <span className="text-xs text-muted-fg">{row.models.length} models</span>
        ) : null}
        {row.err ? <span className="text-xs text-destructive">{row.err}</span> : null}
      </div>
    </div>
  );
}

/**
 * One channel (Telegram / Slack) as its own settings section: brand icon + linked
 * pill in the header, then Setup (step-by-step guide, bot token, copyable webhook
 * URL) and Replies — AI answers with a chosen skill + optional model override, or
 * log-only capture (no LLM, no tokens).
 */
function ChannelCard({
  name,
  icon,
  desc,
  linked,
  token,
  onToken,
  tokenPlaceholder,
  webhook,
  steps,
  manifest,
  secret,
  onSecret,
  secretSet,
  pullChannel,
  onPullChannel,
  verdict,
  lastDeliveryAt,
  lastDeliveryOutcome,
  prefs,
  onPrefs,
  skills,
  providers,
}: {
  name: string;
  icon: IconComponent;
  desc: string;
  linked: boolean;
  /** One actionable sentence about INBOUND deliveries — a stored token says
   *  nothing about whether the platform is still calling us. */
  verdict?: { tone: "ok" | "warn" | "error"; text: string } | null;
  lastDeliveryAt?: string | null;
  lastDeliveryOutcome?: string | null;
  token: string;
  onToken: (v: string) => void;
  tokenPlaceholder: string;
  webhook: string;
  steps: string[];
  /** Platform app manifest to paste when creating the app (Slack) — one paste sets
   *  scopes + events + the request URL. Omitted by platforms without one. */
  manifest?: string;
  /** A conversation to POLL on our own schedule, as well as receiving pushes. */
  pullChannel?: string;
  onPullChannel?: (v: string) => void;
  /** Request-signing secret (Slack). Absent → the channel has no signature check. */
  secret?: string;
  onSecret?: (v: string) => void;
  secretSet?: boolean;
  prefs: ChannelReplyPrefs;
  onPrefs: (up: Partial<ChannelReplyPrefs>) => void;
  skills: Skill[];
  providers: { id: string; label: string }[];
}) {
  // The guide starts open until the bot is linked, then folds away.
  const [guideOpen, setGuideOpen] = useState(!linked);
  const [copied, setCopied] = useState(false);
  const [copiedManifest, setCopiedManifest] = useState(false);
  const ai = prefs.ai !== false;

  function copyWebhook() {
    navigator.clipboard?.writeText(webhook);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function copyManifest() {
    if (!manifest) return;
    navigator.clipboard?.writeText(manifest);
    setCopiedManifest(true);
    setTimeout(() => setCopiedManifest(false), 1200);
  }

  return (
    <Section
      title={name}
      icon={icon}
      desc={desc}
      action={
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
            linked ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-muted text-muted-fg",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", linked ? "bg-accent" : "bg-muted-fg/50")} aria-hidden />
          {linked ? "Linked" : "Not linked"}
        </span>
      }
    >
      <div className="space-y-4">
      {/* Has anything actually ARRIVED? "Linked" only means a token is stored, and
          it stays green while a disabled subscription or a wrong signing secret
          quietly drops every message. */}
      {verdict && verdict.tone !== "ok" ? (
        <p
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            verdict.tone === "error"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-warning/30 bg-warning/10 text-warning",
          )}
        >
          {verdict.text}
        </p>
      ) : null}
      {lastDeliveryAt ? (
        <p className="text-xs text-muted-fg">
          Last inbound delivery: {ago(lastDeliveryAt as string)}
          {lastDeliveryOutcome ? ` · ${lastDeliveryOutcome}` : ""}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-fg">Setup</p>
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          className="text-xs font-medium text-muted-fg underline decoration-border underline-offset-2 hover:text-fg"
        >
          {guideOpen ? "Hide guide" : "Setup guide"}
        </button>
      </div>

      {guideOpen ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <ol className="space-y-1.5 text-xs text-muted-fg">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-fg/10 text-[10px] font-semibold tabular-nums text-fg">
                  {i + 1}
                </span>
                <span className="pt-px">{s}</span>
              </li>
            ))}
          </ol>
          {manifest ? (
            <div className="rounded-md border border-border bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-fg">
                  App manifest — paste at Create New App → From a manifest
                </span>
                <button
                  type="button"
                  onClick={copyManifest}
                  aria-label="Copy app manifest"
                  className="shrink-0 rounded-md p-1 text-muted-fg transition-colors hover:bg-muted hover:text-fg"
                >
                  {copiedManifest ? (
                    <Check width={13} height={13} className="text-accent" />
                  ) : (
                    <Copy width={13} height={13} />
                  )}
                </button>
              </div>
              <pre className="scrollbar-thin max-h-40 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-fg">
                {manifest}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Bot token" hint={linked ? "Linked. Enter a new token to replace it." : undefined}>
          <Input
            type="password"
            value={token}
            onChange={(e) => onToken(e.target.value)}
            placeholder={tokenPlaceholder}
            className="font-mono"
          />
        </Field>
        {onSecret ? (
          <Field
            label="Signing secret"
            hint={
              secretSet
                ? "Saved. Inbound events are signature-checked."
                : "Basic Information → App Credentials. Without it, anyone who knows the webhook URL can post fake events."
            }
          >
            <Input
              type="password"
              value={secret ?? ""}
              onChange={(e) => onSecret(e.target.value)}
              placeholder="a1b2c3…"
              className="font-mono"
            />
          </Field>
        ) : null}
        {onPullChannel ? (
          <Field
            label="Also poll this channel"
            hint="Channel name (daily-log), a comma-separated list, an id, or * for every conversation the bot is in — including DMs. Checked on the app's own schedule, so messages land even if the platform stops pushing. Blank = push only."
          >
            <Input
              value={pullChannel ?? ""}
              onChange={(e) => onPullChannel(e.target.value)}
              placeholder="daily-log  ·  or  *"
              className="font-mono"
            />
          </Field>
        ) : null}
        <Field label="Webhook URL" hint="Point the platform's events here.">
          <div className="flex h-10 items-center gap-1.5 rounded-lg border border-border bg-muted/40 pl-3 pr-1">
            <code className="scrollbar-none flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-fg">
              {webhook}
            </code>
            <button
              type="button"
              onClick={copyWebhook}
              aria-label="Copy webhook URL"
              className="shrink-0 rounded-md p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-fg"
            >
              {copied ? <Check width={13} height={13} className="text-accent" /> : <Copy width={13} height={13} />}
            </button>
          </div>
        </Field>
      </div>

      <div className="border-t border-border pt-4">
        <p className="mb-1.5 text-sm font-medium text-fg">Replies</p>
        <div className="grid max-w-xs grid-cols-2 gap-2">
          {([
            { value: true, label: "AI replies", hint: "grounded chat" },
            { value: false, label: "Log only", hint: "no AI, no tokens" },
          ] as const).map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => onPrefs({ ai: opt.value })}
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition-colors",
                ai === opt.value ? "border-accent bg-accent/10" : "border-border bg-card hover:bg-muted",
              )}
            >
              <span className="block text-sm font-medium text-fg">{opt.label}</span>
              <span className="block text-[11px] text-muted-fg">{opt.hint}</span>
            </button>
          ))}
        </div>
        {ai ? (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Skill">
              <Select value={prefs.skill ?? ""} onChange={(e) => onPrefs({ skill: e.target.value || undefined })}>
                <option value="">Default</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model — provider">
              <Select
                value={prefs.providerId ?? ""}
                onChange={(e) => onPrefs({ providerId: e.target.value || undefined, model: undefined })}
              >
                <option value="">App default</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            {prefs.providerId ? (
              <Field label="Model — id">
                <Input
                  value={prefs.model ?? ""}
                  onChange={(e) => onPrefs({ model: e.target.value || undefined })}
                  placeholder="provider default"
                  className="font-mono text-[13px]"
                />
              </Field>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-fg">
            Every message lands in your inbox as a memo — structure it later from the Pipeline tab.
          </p>
        )}
      </div>
      </div>
    </Section>
  );
}

interface NotificationRow {
  id: string;
  channel: string;
  target: string;
  text: string;
  atLocal: string;
  enabled?: boolean;
  lastSentDay?: string;
  lastError?: string | null;
}

type RuleTriggerUi =
  | { kind: "time"; atLocal: string }
  | { kind: "threshold"; source: string; metric: string; op: string; value: number };
type RuleActionUi = { kind: "text"; text: string } | { kind: "brief"; prompt: string };
interface RuleRow {
  id: string;
  channel: string;
  target: string;
  when: RuleTriggerUi;
  then: RuleActionUi;
  enabled?: boolean;
  lastFiredDay?: string;
  lastError?: string | null;
}

function describeRuleRow(r: RuleRow): { when: string; then: string } {
  const when =
    r.when.kind === "time"
      ? `at ${r.when.atLocal}`
      : `${r.when.source}.${r.when.metric} ${r.when.op} ${r.when.value}`;
  const then = r.then.kind === "text" ? `“${r.then.text}”` : `AI brief: ${r.then.prompt}`;
  return { when, then };
}

/**
 * Agent rules — "when X → message me". A superset of Notifications: the trigger can
 * be a clock time OR a data threshold (a plain compare, no AI), and the action can be
 * a fixed line OR an AI brief (a prompt handed to the grounded agent). Derived from
 * GET /api/rules so it survives reload. Connect the channel under Channels first.
 */
function RulesPanel({ tzResolved }: { tzResolved: string }) {
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [channel, setChannel] = useState("slack");
  const [target, setTarget] = useState("");
  const [whenKind, setWhenKind] = useState<"time" | "threshold">("time");
  const [at, setAt] = useState("20:00");
  const [source, setSource] = useState("whoop");
  const [metric, setMetric] = useState("resting_hr");
  const [op, setOp] = useState(">");
  const [value, setValue] = useState("55");
  const [thenKind, setThenKind] = useState<"text" | "brief">("text");
  const [text, setText] = useState("");
  const [prompt, setPrompt] = useState("Recap my day in 3 lines from my record — highlights, one flag, one nudge.");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState("");
  const [flash, setFlash] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rules", { cache: "no-store" });
      if (res.ok) setRows(((await res.json()).rules as RuleRow[]) ?? []);
    } catch {
      /* keep the last-known list */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function note(m: string) {
    setFlash(m);
    setTimeout(() => setFlash(""), 2800);
  }

  function buildWhen(): RuleTriggerUi {
    if (whenKind === "time") return { kind: "time", atLocal: at };
    return { kind: "threshold", source: source.trim(), metric: metric.trim(), op, value: Number(value) };
  }
  function buildThen(): RuleActionUi {
    return thenKind === "text" ? { kind: "text", text: text.trim() } : { kind: "brief", prompt: prompt.trim() };
  }
  const canSave =
    !!target.trim() &&
    (whenKind === "time" ? !!at : !!source.trim() && !!metric.trim() && value.trim() !== "" && Number.isFinite(Number(value))) &&
    (thenKind === "text" ? !!text.trim() : !!prompt.trim());

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, target: target.trim(), when: buildWhen(), then: buildThen() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return note(body.error || "Could not save.");
      setTarget("");
      await load();
      note("Saved.");
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setTesting(id);
    try {
      const res = await fetch("/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", id }),
      });
      const body = await res.json().catch(() => ({}));
      await load();
      note(res.ok ? "Sent — check the channel." : body.error || "Send failed.");
    } finally {
      setTesting("");
    }
  }

  async function remove(id: string) {
    const res = await fetch("/api/rules", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      await load();
      note("Removed.");
    }
  }

  return (
    <Section
      title="Agent rules"
      icon={Cpu}
      desc="When X → message me. X is a time (an evening brief) or a data line crossing (HR over 55, social over 60 min). The message is a fixed line, or an AI brief the agent writes from your record. Connect the channel under Channels first."
      action={rows.length ? <Badge>{rows.length}</Badge> : undefined}
    >
      <div className="space-y-4">
        {/* WHEN */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-fg">When</span>
            <Select value={whenKind} onChange={(e) => setWhenKind(e.target.value as "time" | "threshold")} className="h-8 w-auto text-[13px]">
              <option value="time">At a time</option>
              <option value="threshold">A metric crosses</option>
            </Select>
          </div>
          {whenKind === "time" ? (
            <Field label={`Time (${tzResolved})`}>
              <Input type="time" value={at} onChange={(e) => setAt(e.target.value)} className="max-w-[10rem]" />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Source" hint="e.g. whoop, browser">
                <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="whoop" className="font-mono text-[13px]" />
              </Field>
              <Field label="Metric" hint="e.g. resting_hr">
                <Input value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="resting_hr" className="font-mono text-[13px]" />
              </Field>
              <Field label="Is">
                <Select value={op} onChange={(e) => setOp(e.target.value)}>
                  <option value=">">over (&gt;)</option>
                  <option value=">=">≥</option>
                  <option value="<">under (&lt;)</option>
                  <option value="<=">≤</option>
                </Select>
              </Field>
              <Field label="Value">
                <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="55" className="font-mono text-[13px]" />
              </Field>
            </div>
          )}
        </div>

        {/* THEN */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-fg">Then send</span>
            <Select value={thenKind} onChange={(e) => setThenKind(e.target.value as "text" | "brief")} className="h-8 w-auto text-[13px]">
              <option value="text">A fixed line</option>
              <option value="brief">An AI brief</option>
            </Select>
          </div>
          {thenKind === "text" ? (
            <Field label="Message">
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Touch grass — an hour on social already." />
            </Field>
          ) : (
            <Field label="Prompt" hint="Handed to the grounded agent; its reply is sent. Costs a token per fire.">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-fg placeholder:text-muted-fg focus:border-accent focus:outline-none"
              />
            </Field>
          )}
        </div>

        {/* WHERE */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="slack">Slack</option>
              <option value="telegram">Telegram</option>
            </Select>
          </Field>
          <Field label="Target" hint="Slack channel/DM id (C0…/U0…) or Telegram chat id">
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="C0123456789" className="font-mono" />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy || !canSave}>
            {busy ? <Spinner width={14} height={14} className="animate-spin" /> : <Plus width={14} height={14} />}
            Add rule
          </Button>
          {flash ? <span className="text-xs text-muted-fg">{flash}</span> : null}
        </div>

        {rows.length ? (
          <div className="scrollbar-thin max-h-64 space-y-1.5 overflow-y-auto border-t border-border pt-3">
            {rows.map((r) => {
              const d = describeRuleRow(r);
              return (
                <div key={r.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      r.enabled === false ? "bg-muted-fg/50" : r.lastError ? "bg-red-500" : "bg-accent",
                    )}
                    aria-hidden
                  />
                  <div
                    className="min-w-0 flex-1 truncate text-[13px] text-fg"
                    title={`${d.when} → ${d.then}\n${r.channel} → ${r.target}` + (r.lastFiredDay ? `\nLast fired: ${r.lastFiredDay}` : "") + (r.lastError ? `\nError: ${r.lastError}` : "")}
                  >
                    <span className="text-muted-fg">{d.when}</span> → {d.then}
                    <span className="text-muted-fg"> · {r.channel}→{r.target}</span>
                    {r.lastError ? <span className="text-red-500"> · error</span> : null}
                  </div>
                  <Button variant="ghost" onClick={() => test(r.id)} disabled={testing === r.id} className="shrink-0">
                    {testing === r.id ? <Spinner width={13} height={13} className="animate-spin" /> : "Test"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => remove(r.id)}
                    aria-label={`Remove ${r.id}`}
                    className="shrink-0 rounded-md p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-red-500"
                  >
                    <Trash width={14} height={14} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Notifications — scheduled OUTBOUND messages the app sends you on a channel at a
 * local time (e.g. 8pm "How was your day?"). Set a time + message, add as many as
 * you like. The list is derived from GET /api/notifications so it survives reload.
 */
function NotificationsPanel({ tzResolved }: { tzResolved: string }) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [channel, setChannel] = useState("slack");
  const [target, setTarget] = useState("");
  const [text, setText] = useState("How was your day?");
  const [at, setAt] = useState("20:00");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState("");
  const [flash, setFlash] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.ok) setRows(((await res.json()).notifications as NotificationRow[]) ?? []);
    } catch {
      /* keep the last-known list */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function note(m: string) {
    setFlash(m);
    setTimeout(() => setFlash(""), 2500);
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, target: target.trim(), text: text.trim(), atLocal: at }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return note(body.error || "Could not save.");
      setTarget("");
      await load();
      note(`Saved — sends daily at ${at}.`);
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setTesting(id);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", id }),
      });
      const body = await res.json().catch(() => ({}));
      await load();
      note(res.ok ? "Sent — check the channel." : body.error || "Send failed.");
    } finally {
      setTesting("");
    }
  }

  async function remove(id: string) {
    const res = await fetch("/api/notifications", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      await load();
      note("Removed.");
    }
  }

  return (
    <Section
      title="Notifications"
      icon={Send}
      desc="A message the app sends YOU on a channel each day at a local time — e.g. an 8pm “How was your day?”. Your reply lands in your record like any other."
      action={rows.length ? <Badge>{rows.length}</Badge> : undefined}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="slack">Slack</option>
              <option value="telegram">Telegram</option>
            </Select>
          </Field>
          <Field label="Target" hint="Slack channel/DM id (C0…/U0…) or Telegram chat id">
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="C0123456789" className="font-mono" />
          </Field>
          <Field label={`Time (${tzResolved})`}>
            <Input type="time" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
          <Field label="Message">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="How was your day?" />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy || !target.trim() || !text.trim()}>
            {busy ? <Spinner width={14} height={14} className="animate-spin" /> : <Plus width={14} height={14} />}
            Add notification
          </Button>
          {flash ? <span className="text-xs text-muted-fg">{flash}</span> : null}
        </div>

        {rows.length ? (
          <div className="scrollbar-thin max-h-64 space-y-1.5 overflow-y-auto border-t border-border pt-3">
            {rows.map((n) => (
              <div key={n.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    n.enabled === false ? "bg-muted-fg/50" : n.lastError ? "bg-red-500" : "bg-accent",
                  )}
                  aria-hidden
                />
                <div
                  className="min-w-0 flex-1 truncate text-[13px] text-fg"
                  title={
                    `${n.atLocal} · ${n.channel} → ${n.target}\n${n.text}` +
                    (n.lastSentDay ? `\nLast sent: ${n.lastSentDay}` : "") +
                    (n.lastError ? `\nError: ${n.lastError}` : "")
                  }
                >
                  <span className="font-mono tabular-nums text-muted-fg">{n.atLocal}</span>{" "}
                  <span className="text-muted-fg">{n.channel}→{n.target}</span> {n.text}
                  {n.lastError ? <span className="text-red-500"> · error</span> : null}
                </div>
                <Button variant="ghost" onClick={() => test(n.id)} disabled={testing === n.id} className="shrink-0">
                  {testing === n.id ? <Spinner width={13} height={13} className="animate-spin" /> : "Send now"}
                </Button>
                <button
                  type="button"
                  onClick={() => remove(n.id)}
                  aria-label={`Remove ${n.id}`}
                  className="shrink-0 rounded-md p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-red-500"
                >
                  <Trash width={14} height={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}
