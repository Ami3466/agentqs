"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme-provider";
import { Check, Eye, EyeOff, Moon, Plus, RefreshCw, Spinner, Sparkles, Sun, Trash } from "@/components/icons";
import { Button, Card, Field, Input, Select, cn } from "@/components/ui";
import { PROVIDERS } from "@/lib/models";
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

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
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
  const [provider, setProvider] = useState(config.llmProvider || "");
  const [model, setModel] = useState(config.model || "");
  const [llmKey, setLlmKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  // Live model list — fetched from the provider's /models, never hardcoded.
  const [models, setModels] = useState<string[]>(config.model ? [config.model] : []);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsErr, setModelsErr] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);

  // Mentors = built-ins + any custom ones added here or from the CLI / MCP / API.
  const [skills, setSkills] = useState<(Skill & { builtin: boolean })[]>(
    SKILLS.map((s) => ({ ...s, builtin: true })),
  );
  const [newName, setNewName] = useState("");
  const [newSystem, setNewSystem] = useState("");
  const [addingMentor, setAddingMentor] = useState(false);
  const [mentorErr, setMentorErr] = useState("");

  async function loadModels() {
    if (!provider) return;
    setLoadingModels(true);
    setModelsErr("");
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, ...(llmKey ? { key: llmKey } : {}) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModelsErr(d.error || "Could not load models.");
        return;
      }
      const list = Array.isArray(d.models) ? (d.models as string[]) : [];
      setModels(list);
      if (list.length && !list.includes(model)) setModel(list[0]);
    } catch {
      setModelsErr("Could not reach the provider.");
    } finally {
      setLoadingModels(false);
    }
  }

  async function refreshSkills() {
    const d = await fetch("/api/skills").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (d && Array.isArray(d.skills)) setSkills(d.skills);
  }

  async function addMentor() {
    setMentorErr("");
    if (newName.trim().length < 2 || newSystem.trim().length < 10) {
      setMentorErr("Give a name and a system prompt (10+ chars).");
      return;
    }
    setAddingMentor(true);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), system: newSystem.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMentorErr(d.error || "Could not add mentor.");
        return;
      }
      setNewName("");
      setNewSystem("");
      await refreshSkills();
    } finally {
      setAddingMentor(false);
    }
  }

  async function removeMentor(id: string) {
    await fetch(`/api/skills?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    await refreshSkills();
  }

  // Local semantic index status (default-on, no key) for the Semantic search section.
  useEffect(() => {
    let alive = true;
    fetch("/api/embeddings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) setEmbed(d as EmbedStatus);
      })
      .catch(() => {});
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && Array.isArray(d.skills)) setSkills(d.skills);
      })
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

    const body: Record<string, string> = {
      username: username.trim(),
      llmProvider: provider,
      model,
      theme,
    };
    if (password) body.password = password;
    if (llmKey) body.llmKey = llmKey;

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
    setLlmKey("");
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="max-w-2xl space-y-5">
      {/* Profile */}
      <Section title="Profile" desc="How you sign in to this instance.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" htmlFor="username">
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </Field>
          <Field
            label="New password"
            htmlFor="password"
            hint="Leave blank to keep your current password."
          >
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

      {/* AI provider */}
      <Section
        title="AI provider"
        desc="Bring your own key. Claude, OpenAI or Gemini — your data never trains anyone's model."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" htmlFor="provider">
              <Select
                id="provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModels([]);
                  setModel("");
                  setModelsErr("");
                }}
              >
                <option value="">Not set</option>
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Model"
              htmlFor="model"
              hint={
                modelsErr
                  ? modelsErr
                  : models.length
                    ? undefined
                    : "Load the live list from your provider."
              }
            >
              <div className="flex gap-2">
                <Select
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!models.length}
                  className="flex-1"
                >
                  {models.length ? (
                    models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))
                  ) : (
                    <option value="">{provider ? "Load models →" : "Pick a provider first"}</option>
                  )}
                </Select>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void loadModels()}
                  disabled={!provider || loadingModels}
                  title="Fetch this provider's live models"
                >
                  {loadingModels ? <Spinner width={14} height={14} /> : <RefreshCw width={14} height={14} />}
                </Button>
              </div>
            </Field>
          </div>

          <Field
            label="API key"
            htmlFor="llmKey"
            hint={
              config.hasLlmKey
                ? `A key is saved (${config.hasLlmKey}). Enter a new one to replace it.`
                : "Stored locally in your data dir. Never sent anywhere but your provider."
            }
          >
            <div className="relative">
              <Input
                id="llmKey"
                type={showKey ? "text" : "password"}
                value={llmKey}
                onChange={(e) => setLlmKey(e.target.value)}
                placeholder={
                  PROVIDERS.find((p) => p.id === provider)?.keyHint || "sk-…"
                }
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
          </Field>
        </div>
      </Section>

      {/* Data */}
      <Section title="Data" desc="Where agentqs stores your config, record and cache.">
        <Field label="Data directory">
          <div className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[13px] text-fg">
            {config.dataDir}
          </div>
        </Field>
        <p className="mt-2 text-xs text-muted-fg">
          Set with the <code className="font-mono">AGENTQS_DATA_DIR</code> env
          var (a restart applies it).
        </p>
      </Section>

      {/* Appearance */}
      <Section title="Appearance" desc="Applies instantly and persists on this device.">
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
                  active
                    ? "border-accent bg-accent/10 text-fg"
                    : "border-border bg-card text-muted-fg hover:bg-muted hover:text-fg",
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
      <Section
        title="Semantic search"
        desc="Find days that felt like this. Embeddings run on a local model — no key, no cost, private. On by default."
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                "inline-flex h-2 w-2 rounded-full",
                embed?.built ? "bg-accent" : "bg-muted-fg/50",
              )}
            />
            <span className="text-fg">
              {embed
                ? embed.built
                  ? `${embed.count} ${embed.count === 1 ? "entry" : "entries"} indexed`
                  : "Not indexed yet — runs on your first search"
                : "Checking…"}
            </span>
            {embed?.stale && embed.built ? (
              <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                out of date
              </span>
            ) : null}
          </div>
          <Button type="button" size="sm" onClick={() => void reindex()} disabled={reindexing}>
            {reindexing ? <Spinner width={14} height={14} /> : <Sparkles width={14} height={14} />}
            {reindexing ? "Reindexing…" : "Reindex now"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-fg">
          Model <code className="font-mono">{embed?.modelId || "agentqs-local-hash-v1"}</code>
          {embed?.backend ? (
            <>
              {" "}
              · store <code className="font-mono">{embed.backend}</code>
            </>
          ) : null}
          . Keyword search (FTS5) stays always-on and free alongside it.
        </p>
      </Section>

      {/* Mentors */}
      <Section
        title="Mentors"
        desc="The voices your chat can take. Pick one from the mentor chip mid-conversation."
      >
        <div className="space-y-2">
          {skills.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
            >
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-fg/50" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">
                  {s.name} <span className="font-mono text-xs text-muted-fg">/{s.id}</span>
                  {s.builtin ? null : (
                    <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-fg">
                      custom
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-fg">{s.blurb}</p>
              </div>
              {s.builtin ? null : (
                <button
                  type="button"
                  onClick={() => void removeMentor(s.id)}
                  className="shrink-0 rounded p-1 text-muted-fg hover:text-destructive"
                  aria-label={`Remove ${s.name}`}
                >
                  <Trash width={15} height={15} />
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Add a mentor */}
        <div className="mt-4 space-y-2 rounded-lg border border-border p-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Mentor name — e.g. Stoic"
          />
          <textarea
            value={newSystem}
            onChange={(e) => setNewSystem(e.target.value)}
            rows={3}
            placeholder="System prompt — how this mentor should think and reply."
            className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg outline-none placeholder:text-muted-fg/70 focus:border-ring/60"
          />
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={() => void addMentor()} disabled={addingMentor}>
              {addingMentor ? <Spinner width={14} height={14} /> : <Plus width={14} height={14} />}
              Add mentor
            </Button>
            {mentorErr ? <span className="text-xs text-destructive">{mentorErr}</span> : null}
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-fg">
          Or from the terminal:{" "}
          <code className="font-mono">agentqs skill add &quot;Stoic&quot; --system &quot;…&quot;</code>
        </p>
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
        {error ? (
          <span className="text-sm text-destructive">{error}</span>
        ) : null}
      </div>
    </form>
  );
}
