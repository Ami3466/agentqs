"use client";

import { useEffect, useState } from "react";
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
import { Button, Card, Checkbox, Field, Input, Select, cn } from "@/components/ui";
import { PROVIDER_TYPES, defaultBaseFor, providerTypeOf } from "@/lib/models";
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
  { id: "skills", label: "Skills", icon: Wand },
  { id: "data", label: "Data", icon: DataIcon },
  { id: "api", label: "API", icon: Key },
];

const HASH_TABS: Record<string, string> = { memos: "voice" };

function tabForHash(hash: string): string | null {
  if (TABS.some((t) => t.id === hash)) return hash;
  return HASH_TABS[hash] ?? null;
}

/** One settings topic: icon chip + title + description over an always-open body.
 *  `action` renders on the right of the header (status pills, quick buttons). */
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
  // Per-channel reply behaviour: AI replies vs log-only, persona, model override.
  const [replies, setReplies] = useState<Record<string, ChannelReplyPrefs>>({
    telegram: { ai: true, ...config.channels.replies.telegram },
    slack: { ai: true, ...config.channels.replies.slack },
  });
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

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
    setTimeout(() => setSaved(false), 2000);
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
      <Section title="Profile" icon={User} desc="Login email and password.">
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
        linked={config.channels.telegram}
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
        linked={config.channels.slack}
        token={slackToken}
        onToken={setSlackToken}
        tokenPlaceholder="xoxb-…"
        webhook={`${origin || "https://<your-host>"}/api/channels/slack`}
        steps={[
          "Create an app at api.slack.com/apps → OAuth & Permissions → add the chat:write, im:history and app_mentions:read bot scopes.",
          "Install the app to your workspace and copy the xoxb- bot token below.",
          "Event Subscriptions → enable, set the Request URL to the webhook URL, subscribe to message.im and app_mention.",
          "DM the bot or @mention it. Plain text chats with your record; “// a note” logs a memo.",
        ]}
        prefs={replies.slack}
        onPrefs={(up) => patchReplies("slack", up)}
        skills={skills}
        providers={keyedProviders.map((p) => ({ id: p.id, label: p.label || providerTypeOf(p.type)?.label || p.type }))}
      />
      </>
      ) : null}

      {tab === "data" ? (
      <>
      {/* Data */}
      <Section title="Data" icon={DataIcon} desc="Where local files live. Keep personal data out of public repositories.">
        <Field label="Record folder">
          <div className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[13px] text-fg">
            {config.recordDir}
          </div>
        </Field>
        <p className="mt-2 text-xs text-muted-fg">
          This is the plain-text journal record. Only sync it to a private repo or private folder, never this public
          app checkout.
        </p>
        <Field label="Data directory">
          <div className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[13px] text-fg">
            {config.dataDir}
          </div>
        </Field>
        <p className="mt-2 text-xs text-muted-fg">
          Set with <code className="font-mono">AGENTQS_DATA_DIR</code> (a restart applies it). Keep the broader data
          directory out of git: it also holds config, model downloads, thumbnails, and rebuildable SQLite caches.
        </p>
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
      <Section id="skills" title="Skills" icon={Wand} desc="Personas you can invoke in chat with /name. Any skill can be deleted — defaults are restorable.">
        <div className="space-y-2">
          {skills.map((s) => (
            <div key={s.id} className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-fg/50" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {s.name} <span className="font-mono text-xs text-muted-fg">/{s.id}</span>
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

/** Core HTTP endpoints the bearer key unlocks — the same routes the app itself uses. */
const ENDPOINTS: { method: string; path: string; body?: string; desc: string }[] = [
  { method: "POST", path: "/api/chat", body: `{"message":"…"}`, desc: "Ask your record — grounded answer with sources." },
  { method: "POST", path: "/api/search", body: `{"query":"…","limit":5}`, desc: "Semantic search — closest days plus a ready answer." },
  { method: "POST", path: "/api/inbox", body: `{"text":"…"}`, desc: "Log a capture to the inbox — zero tokens. GET lists pending captures; DELETE discards one." },
  { method: "POST", path: "/api/structure", body: `{"id":"…"}`, desc: "Structure a pending capture into daily rows with the configured AI (or pass all: true). Pass csv with the extracted date,… rows to structure key-free — same contract as the CLI/MCP tool." },
  { method: "POST", path: "/api/scan", body: `{}`, desc: "Scan data quality: duplicate columns, dead all-zero columns, messy values; findings queue as inbox notifications. GET lists open findings; fix: true applies them all." },
  { method: "GET", path: "/api/journal", desc: "List journal entries (?days=30, ?numeric=1)." },
  { method: "POST", path: "/api/journal/edit", body: `{"edits":[…]}`, desc: "Edit the daily table — set/clear cells, drop rows or columns." },
  { method: "GET", path: "/api/daily", desc: "The structured daily table." },
  { method: "GET", path: "/api/events", desc: "Raw timeline events (?start=YYYY-MM-DD&end=…&limit=500)." },
  { method: "GET", path: "/api/log", desc: "Captured log items; POST /api/log/reject {\"id\":\"…\"} undoes an import." },
  { method: "GET", path: "/api/sources", desc: "Every source and its sync state. POST sets an interval; DELETE disconnects." },
  { method: "GET", path: "/api/pipeline", desc: "Pipeline truth table: per-source origin, credential provenance, schedule, last run outcome, coverage." },
  { method: "POST", path: "/api/import/{source}", body: `{"credential":"…"}`, desc: "Connect an API source with its service key and run a sync (github, whoop, notion, …)." },
  { method: "GET", path: "/api/automations", desc: "Browser-import recipes. POST saves one; POST /api/automations/run replays it; DELETE removes it." },
  { method: "GET", path: "/api/skills", desc: "Mentor skills. POST adds or edits one; DELETE removes it." },
  { method: "GET", path: "/api/graphs", desc: "Saved graph definitions. POST replaces the saved set." },
  { method: "GET", path: "/api/embeddings", desc: "Semantic index status. POST reindexes from the record." },
  { method: "GET", path: "/api/photos", desc: "Photo record status. POST imports a folder; POST /api/photos/search finds photos by description." },
  { method: "GET", path: "/api/channels/{channel}", desc: "Is the telegram / slack bot wired up? The platform webhook POSTs here." },
];

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
  prefs,
  onPrefs,
  skills,
  providers,
}: {
  name: string;
  icon: IconComponent;
  desc: string;
  linked: boolean;
  token: string;
  onToken: (v: string) => void;
  tokenPlaceholder: string;
  webhook: string;
  steps: string[];
  prefs: ChannelReplyPrefs;
  onPrefs: (up: Partial<ChannelReplyPrefs>) => void;
  skills: Skill[];
  providers: { id: string; label: string }[];
}) {
  // The guide starts open until the bot is linked, then folds away.
  const [guideOpen, setGuideOpen] = useState(!linked);
  const [copied, setCopied] = useState(false);
  const ai = prefs.ai !== false;

  function copyWebhook() {
    navigator.clipboard?.writeText(webhook);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
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
        <ol className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-fg">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-fg/10 text-[10px] font-semibold tabular-nums text-fg">
                {i + 1}
              </span>
              <span className="pt-px">{s}</span>
            </li>
          ))}
        </ol>
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
            Every message lands in your inbox as a memo — structure it later from the Data tab.
          </p>
        )}
      </div>
      </div>
    </Section>
  );
}
