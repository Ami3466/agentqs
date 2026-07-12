"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, GitHub, Spinner, Trash } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { Sparkline } from "@/components/sparkline";
import { SourceTitle } from "@/components/source-title";
import { SyncStatus } from "@/components/sync-status";
import { Button, Input } from "@/components/ui";
import { jobActive, type Interval, type SourceJobView } from "@/lib/sources";

interface Day {
  date: string;
  commits: number;
}
interface Status {
  connected: boolean;
  hasData: boolean;
  hasToken: boolean;
  syncedAt: string | null;
  job: SourceJobView | null;
  lastRun: { at: string; ok: boolean; error?: string } | null;
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
  savingInterval = false,
  removing = false,
  job = null,
  onIntervalChange,
  onRemove,
  onSyncStarted,
}: {
  version?: number;
  interval?: Interval;
  due?: boolean;
  savingInterval?: boolean;
  removing?: boolean;
  /** Live/last background job — the panel polls /api/sources and threads it here. */
  job?: SourceJobView | null;
  onIntervalChange?: (i: Interval) => void;
  onRemove?: () => void;
  /** A sync job was just enqueued — the panel starts polling. */
  onSyncStarted?: () => void;
} = {}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false); // the POST round-trip (token test)
  const [error, setError] = useState("");
  // Cadence the user picks AS PART OF connecting — defaults to Daily so a freshly
  // connected source actually auto-syncs (they can still choose Manual here).
  const [pendingInterval, setPendingInterval] = useState<Interval>("daily");

  async function loadStatus() {
    const res = await fetch("/api/import/github");
    if (res.ok) setStatus((await res.json()) as Status);
  }

  // Reload on mount and whenever the shared version bumps — after a lazy
  // auto-sync the sparkline + last-sync line pick up the new commits.
  useEffect(() => {
    void loadStatus();
  }, [version]);

  const liveJob = job ?? status?.job ?? null;
  const syncing = jobActive(liveJob);

  async function sync() {
    const wasConnected = Boolean(status?.connected);
    setBusy(true);
    setError("");
    let res: Response;
    try {
      res = await fetch("/api/import/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(token ? { token } : {}),
      });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not reach the app.");
      return;
    }
    setBusy(false);
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      // A bad token fails HERE (tested against the real API) — nothing saved.
      setError(data.error || "Sync failed.");
      return;
    }
    setToken("");
    setOpen(false);
    // Connected the moment the TESTED token is stored — persist the cadence
    // chosen in the connect form; the sync continues as a background job.
    if (!wasConnected) onIntervalChange?.(pendingInterval);
    await loadStatus();
    onSyncStarted?.();
  }

  const connected = status?.connected;
  const canSyncNow = Boolean(status?.hasToken) || Boolean(token);
  const working = busy || syncing;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <GitHub width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SourceTitle id="github" name="GitHub" hasData={Boolean(status?.hasData)} />
            {connected ? <Check width={13} height={13} className="shrink-0 text-accent" /> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connected && onIntervalChange ? (
            <div className="flex items-center gap-1.5">
              {savingInterval ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
              <IntervalSelect value={interval} onChange={onIntervalChange} disabled={savingInterval} />
            </div>
          ) : null}
          {connected ? (
            <>
              <Button size="sm" variant="secondary" onClick={sync} disabled={working}>
                {working ? <Spinner width={14} height={14} /> : null}
                {syncing ? "Syncing…" : busy ? "Starting…" : "Sync"}
              </Button>
              {onRemove ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onRemove}
                  disabled={removing || syncing}
                  title="Remove this automated import"
                >
                  {removing ? <Spinner width={14} height={14} /> : <Trash width={14} height={14} />}
                  Remove
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => (canSyncNow ? void sync() : setOpen((v) => !v))}
              disabled={working}
            >
              {working ? <Spinner width={14} height={14} /> : null}
              {syncing ? "Syncing…" : busy ? "Testing token…" : canSyncNow ? "Sync" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      {status?.series.length ? (
        <div className="mt-3 pl-12">
          <Spark data={status.series} />
        </div>
      ) : null}

      {open && !connected ? (
        <div className="mt-3 space-y-2 pl-12">
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
            <Button
              size="md"
              variant="primary"
              onClick={sync}
              disabled={working || !token}
              title="Tests the token against the real API first — only a working token is saved"
            >
              {busy ? <Spinner width={16} height={16} /> : null}
              {busy ? "Testing token…" : "Connect & sync"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-fg">Auto-sync</span>
            <IntervalSelect value={pendingInterval} onChange={setPendingInterval} disabled={working} />
          </div>
        </div>
      ) : null}

      <SyncStatus
        job={liveJob}
        lastRunError={status?.lastRun && !status.lastRun.ok ? (status.lastRun.error ?? "sync failed") : null}
        className="mt-2 pl-12"
        onFinished={() => void loadStatus()}
      />
      {error ? <p className="mt-2 pl-12 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
