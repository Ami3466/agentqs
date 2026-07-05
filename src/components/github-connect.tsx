"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, GitHub, Spinner } from "@/components/icons";
import { Badge, Button, Input, cn } from "@/components/ui";

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

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Dependency-free bar sparkline of commits/day, coloured with the accent token. */
function Spark({ data }: { data: Day[] }) {
  if (!data.length) return null;
  const max = Math.max(1, ...data.map((d) => d.commits));
  const w = 4;
  const gap = 2;
  const h = 28;
  return (
    <div className="scrollbar-thin overflow-x-auto">
      <svg
        width={data.length * (w + gap)}
        height={h}
        className="text-accent"
        role="img"
        aria-label={`${data.length}-day commit history`}
      >
        {data.map((d, i) => {
          const bh = Math.max(1, Math.round((d.commits / max) * h));
          return (
            <rect
              key={d.date}
              x={i * (w + gap)}
              y={h - bh}
              width={w}
              height={bh}
              rx={1}
              fill="currentColor"
              opacity={d.commits ? 0.9 : 0.25}
            >
              <title>{`${d.date}: ${d.commits} commit${d.commits === 1 ? "" : "s"}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

export function GithubConnect() {
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

  useEffect(() => {
    void loadStatus();
  }, []);

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

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <GitHub width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-fg">GitHub</p>
            <Badge>api</Badge>
            {connected ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                <Check width={12} height={12} /> connected
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
