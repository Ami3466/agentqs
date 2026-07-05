"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme-provider";
import { Check, Eye, EyeOff, Moon, Spinner, Sparkles, Sun } from "@/components/icons";
import { Button, Card, Field, Input, Select, cn } from "@/components/ui";
import {
  DEFAULT_MODEL,
  PROVIDERS,
  modelsForProvider,
} from "@/lib/models";
import { SKILLS } from "@/lib/skills";
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
  const [model, setModel] = useState(config.model || DEFAULT_MODEL);
  const [llmKey, setLlmKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);

  const providerModels = modelsForProvider(provider);

  // Local semantic index status (default-on, no key) for the Semantic search section.
  useEffect(() => {
    let alive = true;
    fetch("/api/embeddings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d) setEmbed(d as EmbedStatus);
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
                  const next = e.target.value;
                  setProvider(next);
                  const models = modelsForProvider(next);
                  if (models.length && !models.includes(model)) setModel(models[0]);
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
            <Field label="Model" htmlFor="model">
              <Select
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!providerModels.length}
              >
                {providerModels.length ? (
                  providerModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                ) : (
                  <option value="">Pick a provider first</option>
                )}
              </Select>
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

      {/* Personas / skills */}
      <Section
        title="Personas"
        desc="The voices your mentor can take. Switch mid-chat with the skill chip or /skill."
      >
        <div className="space-y-2">
          {SKILLS.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
            >
              <span className="mt-0.5 text-accent">
                <Sparkles width={15} height={15} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {s.name} <span className="font-mono text-xs text-muted-fg">/{s.id}</span>
                </p>
                <p className="text-xs text-muted-fg">{s.blurb}</p>
              </div>
            </div>
          ))}
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
        {error ? (
          <span className="text-sm text-destructive">{error}</span>
        ) : null}
      </div>
    </form>
  );
}
