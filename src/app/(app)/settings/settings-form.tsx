"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme-provider";
import { Check, Eye, EyeOff, Moon, Plus, RefreshCw, Spinner, Sparkles, Sun, Trash } from "@/components/icons";
import { Button, Card, Field, Input, Select, cn } from "@/components/ui";
import { PROVIDER_TYPES, defaultBaseFor, providerTypeOf } from "@/lib/models";
import { SKILLS, type Skill } from "@/lib/skills";
import type { PublicConfig } from "@/lib/config";

interface EmbedStatus {
  built: boolean;
  count: number;
  stale: boolean;
  model: string;
  backend: "sqlite-vec" | "js-cosine" | null;
  modelId: string;
}

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

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {desc ? <p className="mt-0.5 text-sm text-muted-fg">{desc}</p> : null}
      </div>
      {children}
    </Card>
  );
}

export function SettingsForm({ config }: { config: PublicConfig }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

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

  // Embedding / Voice / Channels
  const [embMode, setEmbMode] = useState<"local" | "api">(config.embedding.mode);
  const [embModel, setEmbModel] = useState(config.embedding.model);
  const [embKey, setEmbKey] = useState("");
  const [voiceProvider, setVoiceProvider] = useState(config.voice.provider);
  const [voiceKey, setVoiceKey] = useState("");
  const [voiceAgent, setVoiceAgent] = useState(config.voice.agentId);
  const [tgToken, setTgToken] = useState("");
  const [slackToken, setSlackToken] = useState("");

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
    return () => {
      alive = false;
    };
  }, []);

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
      embedding: { mode: embMode, model: embModel, ...(embKey ? { apiKey: embKey } : {}) },
      voice: { provider: voiceProvider, agentId: voiceAgent, ...(voiceKey ? { apiKey: voiceKey } : {}) },
      channels: {
        ...(tgToken ? { telegramBotToken: tgToken } : {}),
        ...(slackToken ? { slackBotToken: slackToken } : {}),
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
    <form onSubmit={save} className="max-w-2xl space-y-5">
      {/* Profile */}
      <Section title="Profile">
        <div className="grid gap-4 sm:grid-cols-2">
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

      {/* AI providers list */}
      <Section title="AI providers">
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
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Default model — provider">
            <Select
              value={sel?.providerId ?? ""}
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
              value={sel?.model ?? ""}
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
                <option value={sel?.model ?? ""}>{sel?.model || "Load models on the provider"}</option>
              )}
            </Select>
          </Field>
        </div>
      </Section>

      {/* Embedding model */}
      <Section title="Embedding model">
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
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Model">
              <Input value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder="text-embedding-3-small" />
            </Field>
            <Field label="API key" hint={config.embedding.hasKey ? "A key is saved. Enter a new one to replace it." : undefined}>
              <Input type="password" value={embKey} onChange={(e) => setEmbKey(e.target.value)} placeholder="key" className="font-mono" />
            </Field>
          </div>
        )}
      </Section>

      {/* Voice model */}
      <Section title="Voice model">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <Select value={voiceProvider} onChange={(e) => setVoiceProvider(e.target.value as typeof voiceProvider)}>
              <option value="">None</option>
              <option value="elevenlabs">ElevenLabs</option>
              <option value="google-live">Google Live</option>
            </Select>
          </Field>
          {voiceProvider ? (
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

      {/* Channels */}
      <Section title="Channels">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Telegram bot token" hint={config.channels.telegram ? "Linked. Enter a new token to replace it." : undefined}>
            <Input type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC…" className="font-mono" />
          </Field>
          <Field label="Slack bot token" hint={config.channels.slack ? "Linked. Enter a new token to replace it." : undefined}>
            <Input type="password" value={slackToken} onChange={(e) => setSlackToken(e.target.value)} placeholder="xoxb-…" className="font-mono" />
          </Field>
        </div>
        <p className="mt-3 text-xs text-muted-fg">
          Webhook path <code className="font-mono">/api/channels/telegram</code> · <code className="font-mono">/api/channels/slack</code>.
        </p>
      </Section>

      {/* Data */}
      <Section title="Data">
        <Field label="Data directory">
          <div className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[13px] text-fg">
            {config.dataDir}
          </div>
        </Field>
        <p className="mt-2 text-xs text-muted-fg">
          Set with <code className="font-mono">AGENTQS_DATA_DIR</code> (a restart applies it).
        </p>
      </Section>

      {/* Appearance */}
      <Section title="Appearance">
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

      {/* Semantic search (embeddings) */}
      <Section title="Semantic search">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
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
          <Button type="button" size="sm" onClick={() => void reindex()} disabled={reindexing}>
            {reindexing ? <Spinner width={14} height={14} /> : <Sparkles width={14} height={14} />}
            {reindexing ? "Reindexing…" : "Reindex now"}
          </Button>
        </div>
      </Section>

      {/* Skills */}
      <Section title="Skills">
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
              {s.builtin ? null : (
                <button
                  type="button"
                  onClick={() => void removeSkill(s.id)}
                  className="shrink-0 rounded p-1 text-muted-fg hover:text-destructive"
                  aria-label={`Remove ${s.name}`}
                >
                  <Trash width={15} height={15} />
                </button>
              )}
            </div>
          ))}
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

      {/* Save bar */}
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
    </form>
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
          className="w-40"
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

      <div className="grid gap-3 sm:grid-cols-2">
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
