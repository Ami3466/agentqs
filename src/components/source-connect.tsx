"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, sourceIcon, Spinner, Trash } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { Badge, Button, Input, cn } from "@/components/ui";
import { type Interval } from "@/lib/sources";

/**
 * Generic connect/sync row for a single-credential Tier-1 plugin source
 * (RescueTime · Google Calendar · Spotify). The same shape as GithubConnect, driven by
 * the source's own /api/import/<id> GET/POST: paste a credential → sync → headline
 * number + sparkline of the primary metric, an interval dropdown, and version-
 * driven refresh so a lazy auto-sync updates it. Kept generic so a new source is a
 * registry entry, not a new component.
 */

interface Point {
  date: string;
  value: number;
}
interface Status {
  id: string;
  name: string;
  detail: string;
  live: boolean;
  connected: boolean;
  hasData: boolean;
  detectedApp: boolean;
  hasCredential: boolean;
  credentialLabel: string;
  credentialPlaceholder: string;
  primaryMetric: string;
  unit: string;
  syncedAt: string | null;
  days: number;
  latest: number | null;
  average: number | null;
  series: Point[];
}

/** Dependency-free bar sparkline of the primary metric, accent-coloured. */
function Spark({ data }: { data: Point[] }) {
  if (!data.length) return null;
  const max = Math.max(1, ...data.map((d) => d.value));
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
        aria-label={`${data.length}-day history`}
      >
        {data.map((d, i) => {
          const bh = Math.max(1, Math.round((d.value / max) * h));
          return (
            <rect key={d.date} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1} fill="currentColor" opacity={d.value ? 0.9 : 0.25}>
              <title>{`${d.date}: ${d.value}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

export function SourceConnect({
  id,
  version = 0,
  interval = "off",
  savingInterval = false,
  removing = false,
  credentialOrigin = null,
  lastRunError = null,
  onIntervalChange,
  onRemove,
}: {
  id: string;
  version?: number;
  interval?: Interval;
  due?: boolean;
  savingInterval?: boolean;
  removing?: boolean;
  credentialOrigin?: "env" | "saved" | "discovered" | null;
  lastRunError?: string | null;
  onIntervalChange?: (i: Interval) => void;
  onRemove?: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [cred, setCred] = useState("");
  const [showCred, setShowCred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  // Cadence chosen AS PART OF connecting — defaults to Daily so a newly connected
  // API source actually auto-syncs (Manual is still selectable here).
  const [pendingInterval, setPendingInterval] = useState<Interval>("daily");

  async function loadStatus() {
    const res = await fetch(`/api/import/${id}`);
    if (res.ok) setStatus((await res.json()) as Status);
  }

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, id]);

  async function sync() {
    const wasConnected = Boolean(status?.connected);
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch(`/api/import/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // "Use detected app" = explicit opt-in to the desktop-app token; the
      // server persists it, so this source is connected from here on.
      body: JSON.stringify(cred ? { credential: cred } : status?.detectedApp && !status?.connected ? { useDetected: true } : {}),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Sync failed.");
      return;
    }
    setCred("");
    setOpen(false);
    setMsg(`${data.days} day${data.days === 1 ? "" : "s"} of ${data.name} → ${data.dailyRows} daily rows.`);
    // First-time connect → persist the cadence chosen in the connect form.
    if (!wasConnected) onIntervalChange?.(pendingInterval);
    await loadStatus();
    setTimeout(() => setMsg(""), 6000);
  }

  const Icon = sourceIcon(id);
  const connected = status?.connected;
  const live = status?.live ?? true;
  const detectedApp = Boolean(status?.detectedApp) && !connected;
  const canSyncNow = Boolean(status?.hasCredential) || Boolean(cred) || detectedApp;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-fg">{status?.name ?? id}</p>
            {connected ? <Check width={13} height={13} className="shrink-0 text-accent" /> : null}
            {!connected && status?.hasData ? (
              <Badge title="Rows from this source exist in your record (imported), but the app holds no authorization to sync more. Connect to keep it updated.">
                imported data — not connected
              </Badge>
            ) : null}
          </div>
          {lastRunError ? (
            <p className="truncate text-xs text-destructive" title={lastRunError}>
              Last sync failed: {lastRunError}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {live && connected && onIntervalChange ? (
            <div className="flex items-center gap-1.5">
              {savingInterval ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
              <IntervalSelect value={interval} onChange={onIntervalChange} disabled={savingInterval} />
            </div>
          ) : null}
          {connected ? (
            <>
              <Button size="sm" variant="secondary" onClick={sync} disabled={busy}>
                {busy ? <Spinner width={14} height={14} /> : null}
                {busy ? "Syncing…" : "Sync"}
              </Button>
              {onRemove ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onRemove}
                  disabled={removing}
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
              disabled={busy}
            >
              {busy ? <Spinner width={14} height={14} /> : null}
              {busy ? "Syncing…" : detectedApp ? "Connect (use detected app)" : canSyncNow ? "Sync" : "Connect"}
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
                type={showCred ? "text" : "password"}
                value={cred}
                onChange={(e) => setCred(e.target.value)}
                placeholder={status?.credentialPlaceholder ?? "credential"}
                autoComplete="off"
                className="pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowCred((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-fg hover:text-fg"
                aria-label={showCred ? "Hide credential" : "Show credential"}
              >
                {showCred ? <EyeOff width={16} height={16} /> : <Eye width={16} height={16} />}
              </button>
            </div>
            <Button size="md" variant="primary" onClick={sync} disabled={busy || !cred}>
              {busy ? <Spinner width={16} height={16} /> : null}
              {busy ? "Syncing…" : "Connect & sync"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-fg">Auto-sync</span>
            <IntervalSelect value={pendingInterval} onChange={setPendingInterval} disabled={busy} />
          </div>
        </div>
      ) : null}

      {msg ? <p className={cn("mt-2 pl-12 text-xs text-accent")}>{msg}</p> : null}
      {error ? <p className="mt-2 pl-12 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
