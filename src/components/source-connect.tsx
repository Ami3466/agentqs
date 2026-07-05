"use client";

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, RefreshCw, Spinner } from "@/components/icons";
import { brandIcon } from "@/components/brand-icons";
import { IntervalSelect } from "@/components/interval-select";
import { Badge, Button, Input, cn } from "@/components/ui";
import { ago, type Interval } from "@/lib/sources";
import { markTourStep } from "@/lib/tour";

/**
 * Generic connect/sync row for a Tier-1 plugin source (RescueTime · Google
 * Calendar · Spotify · WHOOP-stub). The same shape as GithubConnect, driven by
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
  due = false,
  savingInterval = false,
  onIntervalChange,
}: {
  id: string;
  version?: number;
  interval?: Interval;
  due?: boolean;
  savingInterval?: boolean;
  onIntervalChange?: (i: Interval) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [cred, setCred] = useState("");
  const [showCred, setShowCred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function loadStatus() {
    const res = await fetch(`/api/import/${id}`);
    if (res.ok) setStatus((await res.json()) as Status);
  }

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, id]);

  async function sync() {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch(`/api/import/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cred ? { credential: cred } : {}),
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
    await loadStatus();
    markTourStep("source"); // real action: a source is now connected — tour re-confirms
    setTimeout(() => setMsg(""), 6000);
  }

  const Icon = brandIcon(id);
  const connected = status?.connected;
  const live = status?.live ?? true;
  const isOauth = (status?.credentialLabel ?? "").toLowerCase().includes("oauth");
  const canSyncNow = Boolean(status?.hasCredential) || Boolean(cred);
  const dayLabel = status ? `${status.days} day${status.days === 1 ? "" : "s"}` : "";
  const headline = status
    ? status.average != null
      ? `${status.average} ${status.unit || status.primaryMetric} · ${dayLabel}`
      : dayLabel
    : "";

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-fg">{status?.name ?? id}</p>
            <Badge>api</Badge>
            {!live ? (
              <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
                stub · OAuth soon
              </span>
            ) : isOauth ? (
              <span
                className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-fg"
                title="Paste an OAuth access token — no in-app OAuth redirect yet"
              >
                OAuth · paste token
              </span>
            ) : null}
            {connected ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                <Check width={12} height={12} /> connected
              </span>
            ) : null}
            {live && connected && interval !== "off" ? (
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
            {connected ? `${headline} · synced ${ago(status?.syncedAt ?? null)}` : status?.detail ?? ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {live && connected && onIntervalChange ? (
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
            Paste your {status?.credentialLabel ?? "credential"}. Stored in your data dir; used only
            to read {status?.name ?? "this source"}.
            {isOauth ? " It's a short-lived OAuth token — paste a fresh one when it expires." : ""}
          </p>
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
        </div>
      ) : null}

      {msg ? <p className={cn("mt-2 pl-12 text-xs text-accent")}>{msg}</p> : null}
      {error ? <p className="mt-2 pl-12 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
