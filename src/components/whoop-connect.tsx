"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, sourceIcon, Spinner, Trash } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { Sparkline } from "@/components/sparkline";
import { SourceTitle } from "@/components/source-title";
import { SyncStatus } from "@/components/sync-status";
import { Button, Input } from "@/components/ui";
import { jobActive, type Interval, type SourceJobView } from "@/lib/sources";

/**
 * WHOOP connect/sync row — the differentiator, wired to the UNOFFICIAL app login.
 * Two fields (email + password), not a single token: they POST to /api/import/whoop
 * which LOGS IN first (a bad password fails right here, nothing stored) and then
 * pulls per-minute heart rate + HRV + recovery + sleep + strain as a background
 * job — the row shows the job's live progress and it survives page refreshes.
 * Bespoke (like GitHub) because that two-field auth + the minute-level stream
 * don't fit the single-credential SourceConnect. Recovery drives the sparkline.
 */

interface Point {
  date: string;
  value: number;
}
interface Status {
  connected: boolean;
  email: string;
  hasData: boolean;
  hasCredential: boolean;
  syncedAt: string | null;
  job: SourceJobView | null;
  lastRun: { at: string; ok: boolean; error?: string } | null;
  days: number;
  latest: number | null;
  average: number | null;
  minutes: number;
  series: Point[];
}

export function WhoopConnect({
  id = "whoop",
  version = 0,
  interval = "off",
  savingInterval = false,
  removing = false,
  job = null,
  onIntervalChange,
  onRemove,
  onSyncStarted,
}: {
  /** The WHOOP account this row drives: base "whoop" or an extra "whoop-2". */
  id?: string;
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false); // the POST round-trip (login test)
  const [error, setError] = useState("");
  const [pendingInterval, setPendingInterval] = useState<Interval>("daily");
  // Every call carries ?instance so a second athlete's row hits its own account.
  const endpoint = id === "whoop" ? "/api/import/whoop" : `/api/import/whoop?instance=${id}`;
  const m = id.match(/^whoop-(\d+)$/);
  const title = m ? `WHOOP · account ${m[1]} (per-minute, unofficial)` : "WHOOP (per-minute, unofficial)";

  async function loadStatus() {
    const res = await fetch(endpoint);
    if (res.ok) setStatus((await res.json()) as Status);
  }

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, id]);

  const liveJob = job ?? status?.job ?? null;
  const syncing = jobActive(liveJob);

  async function sync(withCreds: boolean) {
    const wasConnected = Boolean(status?.connected);
    setBusy(true);
    setError("");
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withCreds ? { email, password } : {}),
      });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not reach the app.");
      return;
    }
    setBusy(false);
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      // A bad login fails HERE (tested against the real WHOOP auth) — nothing stored.
      setError(data.error || "Sync failed.");
      return;
    }
    setPassword("");
    setOpen(false);
    // Connected the moment the TESTED login is stored — persist the cadence
    // chosen in the connect form; the sync continues as a background job.
    if (!wasConnected) onIntervalChange?.(pendingInterval);
    await loadStatus();
    onSyncStarted?.();
  }

  const Icon = sourceIcon("whoop");
  const connected = status?.connected;
  const canSyncNow = Boolean(status?.hasCredential);
  const working = busy || syncing;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SourceTitle id="whoop" name={title} hasData={Boolean(status?.hasData)} title="Per-minute heart rate via the unofficial app login — the official API connect is the plain WHOOP row" />
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
              <Button size="sm" variant="secondary" onClick={() => void sync(false)} disabled={working}>
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
              onClick={() => (canSyncNow ? void sync(false) : setOpen((v) => !v))}
              disabled={working}
            >
              {working ? <Spinner width={14} height={14} /> : null}
              {syncing ? "Syncing…" : busy ? "Connecting…" : canSyncNow ? "Sync" : "Connect"}
            </Button>
          )}
        </div>
      </div>

      {status?.series.length ? (
        <div className="mt-3 pl-12">
          <Sparkline
            points={status.series}
            variant="bar"
            ariaLabel={`${status.series.length}-day recovery history`}
            title={(p) => `${p.date}: ${p.value}% recovery`}
          />
        </div>
      ) : null}

      {open && !connected ? (
        <div className="mt-3 space-y-2 pl-12">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            autoComplete="off"
          />
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="WHOOP password"
                autoComplete="off"
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-fg hover:text-fg"
                aria-label={showPw ? "Hide password" : "Show password"}
              >
                {showPw ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
              </button>
            </div>
            <Button
              size="md"
              variant="primary"
              onClick={() => void sync(true)}
              disabled={working || !email || !password}
              title="Logs in to WHOOP first — only a working login is saved"
            >
              {busy ? <Spinner width={16} height={16} /> : null}
              {busy ? "Testing login…" : "Connect & sync"}
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
