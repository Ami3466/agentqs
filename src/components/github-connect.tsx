"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, RefreshCw, Spinner } from "@/components/icons";
import { brandIcon } from "@/components/brand-icons";
import { IntervalSelect } from "@/components/interval-select";
import { Sparkline } from "@/components/sparkline";
import { Badge, Button, Input, cn } from "@/components/ui";
import { ago, type Interval } from "@/lib/sources";

interface Day {
  date: string;
  commits: number;
}
interface Status {
  connected: boolean;
  hasToken: boolean;
  syncedAt: string | null;
  total: number;
  series: Day[];
}

/** Commits/day as a bar sparkline (the shared, accent-coloured Sparkline). */
function Spark({ data }: { data: Day[] }) {
  if (!data.length) return null;
  return (
    <Sparkline
      points={data.map((d) => ({ date: d.date, value: d.commits }))}
      variant="bar"
      ariaLabel={`${data.length}-day commit history`}
      title={(p) => `${p.date}: ${p.value} commit${p.value === 1 ? "" : "s"}`}
    />
  );
}

export function GithubConnect({
  version = 0,
  interval = "off",
  due = false,
  savingInterval = false,
  onIntervalChange,
}: {
  version?: number;
  interval?: Interval;
  due?: boolean;
  savingInterval?: boolean;
  onIntervalChange?: (i: Interval) => void;
} = {}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function loadStatus() {
    const res = await fetch("/api/import/github");
    if (res.ok) setStatus((await res.json()) as Status);
  }

  // Reload on mount and whenever the shared version bumps — after a lazy
  // auto-sync the sparkline + last-sync line pick up the new commits.
  useEffect(() => {
    void loadStatus();
  }, [version]);

  async function sync() {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/import/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(token ? { token } : {}),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Sync failed.");
      return;
    }
    setToken("");
    setOpen(false);
    setMsg(
      `${data.commits} commits from @${data.login}${data.capped ? " (capped)" : ""} → ${data.dailyRows} daily rows.`,
    );
    await loadStatus();
    setTimeout(() => setMsg(""), 6000);
  }

  const connected = status?.connected;
  const canSyncNow = Boolean(status?.hasToken) || Boolean(token);
  const Icon = brandIcon("github");

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-fg">GitHub</p>
            <Badge>api</Badge>
            {connected ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                <Check width={12} height={12} /> connected
              </span>
            ) : null}
            {connected && interval !== "off" ? (
              <span
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-fg"
                title={due ? "Overdue — auto-syncs when the Data tab opens" : "Scheduled auto-sync"}
              >
                <RefreshCw width={11} height={11} />
                {due ? "auto-syncs on open" : `syncs ${interval}`}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-fg">
            {connected
              ? `${status?.total} commits · synced ${ago(status?.syncedAt ?? null)}`
              : "commits per day"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {connected && onIntervalChange ? (
            <div className="flex items-center gap-1.5">
              {savingInterval ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
              <IntervalSelect value={interval} onChange={onIntervalChange} disabled={savingInterval} />
            </div>
          ) : null}
          {connected ? (
            <Button size="sm" variant="secondary" onClick={sync} disabled={busy}>
              {busy ? <Spinner width={14} height={14} /> : null}
              {busy ? "Syncing…" : "Sync"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => (canSyncNow ? void sync() : setOpen((v) => !v))}
              disabled={busy}
            >
              {busy ? <Spinner width={14} height={14} /> : null}
              {busy ? "Syncing…" : canSyncNow ? "Sync" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      {connected && status?.series.length ? (
        <div className="mt-3 pl-12">
          <Spark data={status.series} />
        </div>
      ) : null}

      {open && !connected ? (
        <div className="mt-3 space-y-2 pl-12">
          <p className="text-xs text-muted-fg">
            Paste a GitHub token (a fine-grained PAT, read-only, or a classic{" "}
            <code className="font-mono">repo</code> token). Stored in your data dir; used only to
            read your commit counts. Or set <code className="font-mono">GITHUB_TOKEN</code> in the
            environment.
          </p>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_…"
                autoComplete="off"
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-fg hover:text-fg"
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
              </button>
            </div>
            <Button size="md" variant="primary" onClick={sync} disabled={busy || !token}>
              {busy ? <Spinner width={16} height={16} /> : null}
              {busy ? "Syncing…" : "Connect & sync"}
            </Button>
          </div>
        </div>
      ) : null}

      {msg ? (
        <p className={cn("mt-2 pl-12 text-xs text-accent")}>{msg}</p>
      ) : null}
      {error ? <p className="mt-2 pl-12 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
