"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/icons";
import { Button, Field, Input, Select } from "@/components/ui";
import { PROVIDERS } from "@/lib/models";

export function SetupForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [llmKey, setLlmKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function resetModels() {
    setModels([]);
    setModel("");
    setLoadMsg("");
  }

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
        resetModels();
        setLoadMsg(data.error || "Could not load models.");
      }
    } catch {
      resetModels();
      setLoadMsg("Could not reach the provider.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (username.trim().length < 2) return setError("Pick a username (2+ characters).");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords don't match.");

    setBusy(true);
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.trim(),
        password,
        llmProvider: provider,
        model: provider ? model : "",
        llmKey: provider ? llmKey : "",
        llmModels: provider ? models : [],
      }),
    });
    setBusy(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Setup failed.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Username" htmlFor="username">
        <Input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="you"
          autoComplete="username"
          autoFocus
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="6+ characters"
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm" htmlFor="confirm">
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="repeat"
            autoComplete="new-password"
          />
        </Field>
      </div>

      <div className="rounded-lg border border-border bg-muted/50 p-3">
        <p className="mb-3 text-xs font-medium text-muted-fg">
          AI provider — optional, add it later in Settings.
        </p>
        <Select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setLlmKey("");
            resetModels();
          }}
        >
          <option value="">No provider yet</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>

        {provider ? (
          <div className="mt-3 space-y-3">
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={llmKey}
                onChange={(e) => {
                  setLlmKey(e.target.value);
                  resetModels();
                }}
                placeholder={PROVIDERS.find((p) => p.id === provider)?.keyHint || "API key"}
                autoComplete="off"
                className="pr-16 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-xs text-muted-fg hover:text-fg"
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                onClick={() => void loadModels()}
                disabled={!llmKey || loading}
                size="sm"
              >
                {loading ? <Spinner width={14} height={14} /> : null}
                {loading ? "Connecting…" : "Connect & load models"}
              </Button>
              {loadMsg ? <span className="text-xs text-muted-fg">{loadMsg}</span> : null}
            </div>

            <Select
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
          </div>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? <Spinner width={16} height={16} /> : null}
        {busy ? "Creating…" : "Create & enter"}
      </Button>
    </form>
  );
}
