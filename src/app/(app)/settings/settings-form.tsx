"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/theme-provider";
import { Check, Eye, EyeOff, Moon, Person, Plus, RefreshCw, Spinner, Sun, Trash, X } from "@/components/icons";
import { Button, Card, Field, Input, Select, Textarea, cn } from "@/components/ui";
import { PROVIDERS } from "@/lib/models";
import { isBuiltinMentor, type Mentor } from "@/lib/mentors";
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
  const [models, setModels] = useState<string[]>(config.llmModels || []);
  const [llmKey, setLlmKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [embed, setEmbed] = useState<EmbedStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);

  async function loadModels() {
    setError("");
    setLoadMsg("Connecting…");
    setLoading(true);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key: llmKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setModels(data.models);
        setModel(data.models[0] ?? "");
        setLoadMsg(`Loaded ${data.models.length} models`);
      } else {
        setModels([]);
        setModel("");
        setLoadMsg(data.error || "Could not load models.");
      }
    } catch {
      setModels([]);
      setModel("");
      setLoadMsg("Could not reach the provider.");
    } finally {
      setLoading(false);
    }
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
      llmProvider: provider,
      model,
      llmModels: models,
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
    <div className="max-w-2xl space-y-5">
    <form onSubmit={save} className="space-y-5">
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
          <Field label="Provider" htmlFor="provider">
            <Select
              id="provider"
              value={provider}
              onChange={(e) => {
                const next = e.target.value;
                setProvider(next);
                setLlmKey("");
                setLoadMsg("");
                if (next === config.llmProvider) {
                  setModels(config.llmModels || []);
                  setModel(config.model || "");
                } else {
                  setModels([]);
                  setModel("");
                }
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

          {provider ? (
            <Field
              label="API key"
              htmlFor="llmKey"
              hint={
                config.hasLlmKey
                  ? `A key is saved (${config.hasLlmKey}). Paste a new one and reconnect to replace it.`
                  : "Stored locally in your data dir. Never sent anywhere but your provider."
              }
            >
              <div className="relative">
                <Input
                  id="llmKey"
                  type={showKey ? "text" : "password"}
                  value={llmKey}
                  onChange={(e) => setLlmKey(e.target.value)}
                  placeholder={PROVIDERS.find((p) => p.id === provider)?.keyHint || "sk-…"}
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
          ) : null}

          {provider ? (
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                onClick={() => void loadModels()}
                disabled={!llmKey || loading}
              >
                {loading ? <Spinner width={14} height={14} /> : null}
                {loading ? "Connecting…" : "Connect & load models"}
              </Button>
              {loadMsg ? <span className="text-xs text-muted-fg">{loadMsg}</span> : null}
            </div>
          ) : null}

          {provider ? (
            <Field label="Model" htmlFor="model">
              <Select
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!models.length}
              >
                {models.length ? (
                  models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                ) : (
                  <option value="">Connect a key to load models</option>
                )}
              </Select>
            </Field>
          ) : null}
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
              <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
                out of date
              </span>
            ) : null}
          </div>
          <Button type="button" size="sm" onClick={() => void reindex()} disabled={reindexing}>
            {reindexing ? <Spinner width={14} height={14} /> : <RefreshCw width={14} height={14} />}
            {reindexing ? "Reindexing…" : "Reindex now"}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-fg">
          Model <code className="font-mono">{embed?.modelId || "all-MiniLM-L6-v2"}</code>
          {embed?.backend ? (
            <>
              {" "}
              · store <code className="font-mono">{embed.backend}</code>
            </>
          ) : null}
          . Keyword search (FTS5) stays always-on and free alongside it.
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

      {/* Mentors — persisted independently via /api/mentors, not the Save bar above */}
      <MentorsEditor initial={config.mentors} />
    </div>
  );
}

// ---- Mentors editor -------------------------------------------------------

const preview = (s: string) => (s.length > 130 ? `${s.slice(0, 129).trimEnd()}…` : s);

/**
 * Add / edit / delete the mentors the chat can wear. Built-ins arrive as editable
 * rows; every change persists to config.json via /api/mentors on its own (this
 * section is independent of the page's Save button) so it survives a reload and
 * shows up in the chat chip immediately.
 */
function MentorsEditor({ initial }: { initial: Mentor[] }) {
  const [mentors, setMentors] = useState<Mentor[]>(initial);
  const [editing, setEditing] = useState<string | null>(null); // a mentor id, "new", or null
  const [name, setName] = useState("");
  const [blurb, setBlurb] = useState("");
  const [system, setSystem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  function openNew() {
    setEditing("new");
    setName("");
    setBlurb("");
    setSystem("");
    setError("");
    setConfirmId(null);
  }
  function openEdit(m: Mentor) {
    setEditing(m.id);
    setName(m.name);
    setBlurb(m.blurb);
    setSystem(m.system);
    setError("");
    setConfirmId(null);
  }

  async function save() {
    if (!name.trim()) return setError("Give the mentor a name.");
    if (!system.trim()) return setError("Add a system prompt — it's what drives the reply.");
    setBusy(true);
    setError("");
    try {
      const creating = editing === "new";
      const res = await fetch("/api/mentors", {
        method: creating ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          creating ? { name, blurb, system } : { id: editing, name, blurb, system },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.mentors)) {
        setError(data.error || "Could not save the mentor.");
        return;
      }
      setMentors(data.mentors);
      setEditing(null);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/mentors", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.mentors)) {
        setError(data.error || "Could not delete the mentor.");
        return;
      }
      setMentors(data.mentors);
      setConfirmId(null);
      if (editing === id) setEditing(null);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const editorCard = (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-fg">{editing === "new" ? "New mentor" : "Edit mentor"}</p>
        <button
          type="button"
          onClick={() => setEditing(null)}
          className="rounded p-1 text-muted-fg hover:text-fg"
          aria-label="Close editor"
        >
          <X width={16} height={16} />
        </button>
      </div>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="m-name">
            <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Stoic" maxLength={40} />
          </Field>
          <Field label="One-line blurb" htmlFor="m-blurb">
            <Input
              id="m-blurb"
              value={blurb}
              onChange={(e) => setBlurb(e.target.value)}
              placeholder="Calm, principled, cuts to what you control"
              maxLength={120}
            />
          </Field>
        </div>
        <Field label="System prompt" htmlFor="m-system" hint="Handed to the model as the mentor's voice — this is what drives the reply.">
          <Textarea
            id="m-system"
            rows={5}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="You are a Stoic mentor. Ground the reply in the user's real record, separate what they control from what they don't, and end on one action within their control."
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="button" variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? <Spinner width={14} height={14} /> : null}
            {editing === "new" ? "Add mentor" : "Save mentor"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <Section
      title="Mentors"
      desc="Voices you switch between mid-chat with the chip or /mentor. Add your own or tweak the built-ins."
    >
      <div className="space-y-2">
        {mentors.map((m) =>
          editing === m.id ? (
            <div key={m.id}>{editorCard}</div>
          ) : (
            <div
              key={m.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
            >
              <span className="mt-0.5 text-accent">
                <Person width={15} height={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-fg">
                  {m.name}
                  {isBuiltinMentor(m.id) ? (
                    <span className="rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
                      built-in
                    </span>
                  ) : null}
                </p>
                {m.blurb ? <p className="text-xs text-muted-fg">{m.blurb}</p> : null}
                <p className="mt-1 text-xs text-muted-fg/80">{preview(m.system)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {confirmId === m.id ? (
                  <>
                    <Button type="button" size="sm" variant="danger" onClick={() => void remove(m.id)} disabled={busy}>
                      {busy ? <Spinner width={14} height={14} /> : null} Delete
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <>
                    <Button type="button" size="sm" variant="ghost" onClick={() => openEdit(m)} disabled={busy}>
                      Edit
                    </Button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmId(m.id);
                        setError("");
                      }}
                      disabled={busy}
                      className="rounded-lg p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-fg disabled:opacity-50"
                      aria-label={`Delete ${m.name}`}
                    >
                      <Trash width={15} height={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {editing === "new" ? (
        <div className="mt-2">{editorCard}</div>
      ) : editing === null ? (
        <Button type="button" size="sm" className="mt-3" onClick={openNew}>
          <Plus width={14} height={14} /> Add mentor
        </Button>
      ) : null}

      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </Section>
  );
}
