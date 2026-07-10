"use client";

import { useEffect, useRef, useState } from "react";
import { useCopy } from "@/components/connect-api";
import { Check, Copy, Eye, EyeOff, sourceIcon, Spinner, Trash } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { SyncStatus } from "@/components/sync-status";
import { Badge, Button, Input } from "@/components/ui";
import { jobActive, type Interval, type SourceJobView } from "@/lib/sources";

/**
 * Generic connect/sync row for a single-credential Tier-1 plugin source
 * (RescueTime · Google Calendar · Spotify). The same shape as GithubConnect, driven by
 * the source's own /api/import/<id> GET/POST. Connecting TESTS the pasted key
 * against the real API before anything is saved; the sync then runs as a
 * BACKGROUND JOB on the server — the row shows its live progress bar (from
 * server state, so it survives refreshes) and the panel polls until it lands.
 * Kept generic so a new source is a registry entry, not a new component.
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
  credentialHelp: { url: string; steps: string[] } | null;
  oauth: { supported: boolean; authorized: boolean; clientId: string } | null;
  primaryMetric: string;
  unit: string;
  syncedAt: string | null;
  job: SourceJobView | null;
  lastRun: { at: string; ok: boolean; error?: string } | null;
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
  job = null,
  onIntervalChange,
  onRemove,
  onSyncStarted,
}: {
  id: string;
  version?: number;
  interval?: Interval;
  due?: boolean;
  savingInterval?: boolean;
  removing?: boolean;
  credentialOrigin?: "env" | "saved" | "discovered" | null;
  /** Live/last background job — the panel polls /api/sources and threads it here. */
  job?: SourceJobView | null;
  onIntervalChange?: (i: Interval) => void;
  onRemove?: () => void;
  /** A sync job was just enqueued — the panel starts polling. */
  onSyncStarted?: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [cred, setCred] = useState("");
  const [showCred, setShowCred] = useState(false);
  const [busy, setBusy] = useState(false); // the POST round-trip (credential test)
  const [error, setError] = useState("");
  // OAuth connect (expiring-token sources): the user's provider app + the dance.
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copied, copy] = useCopy();
  const handledReturn = useRef(false);
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

  // Prefer the panel's freshly polled job over this row's own (older) GET.
  const liveJob = job ?? status?.job ?? null;
  const syncing = jobActive(liveJob);

  // Returning from the provider's authorize page (/api/oauth/callback bounced
  // here with ?source=<id>&connected=1 or &oauth_error=…): kick the first sync,
  // or surface the failure on this row. Runs once, then cleans the URL.
  useEffect(() => {
    if (!status || handledReturn.current) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("source") !== id) return;
    handledReturn.current = true;
    const oauthError = p.get("oauth_error");
    window.history.replaceState(null, "", window.location.pathname);
    if (oauthError) {
      setOpen(true);
      setError(oauthError);
    } else if (p.get("connected")) {
      void sync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, id]);

  /** Save the provider app creds, then send the browser to the authorize page. */
  async function authorize() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/oauth/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, origin: window.location.origin }),
      });
      const data = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; error?: string };
      if (!res.ok || !data.authorizeUrl) {
        setBusy(false);
        setError(data.error || "Could not start the authorization.");
        return;
      }
      window.location.href = data.authorizeUrl;
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not reach the app.");
    }
  }

  async function sync() {
    const wasConnected = Boolean(status?.connected);
    setBusy(true);
    setError("");
    let res: Response;
    try {
      res = await fetch(`/api/import/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // "Use detected app" = explicit opt-in to the desktop-app token; the
        // server persists it, so this source is connected from here on.
        body: JSON.stringify(cred ? { credential: cred } : status?.detectedApp && !status?.connected ? { useDetected: true } : {}),
      });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not reach the app.");
      return;
    }
    setBusy(false);
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      // A bad credential fails HERE (tested against the real API) — nothing saved.
      setError(data.error || "Sync failed.");
      return;
    }
    setCred("");
    setOpen(false);
    // Connected the moment a TESTED credential is stored — persist the cadence
    // chosen in the connect form; the sync itself continues in the background.
    if (!wasConnected) onIntervalChange?.(pendingInterval);
    await loadStatus();
    onSyncStarted?.();
  }

  const Icon = sourceIcon(id);
  // Guarded for SSR — only read once the panel is open (post-hydration anyway).
  const redirectUri = typeof window === "undefined" ? "" : `${window.location.origin}/api/oauth/callback`;
  const connected = status?.connected;
  const live = status?.live ?? true;
  const detectedApp = Boolean(status?.detectedApp) && !connected;
  const canSyncNow = Boolean(status?.hasCredential) || Boolean(cred) || detectedApp;
  const working = busy || syncing;
  const startLabel = busy ? (cred ? "Testing key…" : "Starting…") : "Sync";

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
              <Button size="sm" variant="secondary" onClick={sync} disabled={working}>
                {working ? <Spinner width={14} height={14} /> : null}
                {syncing ? "Syncing…" : startLabel}
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
              {syncing ? "Syncing…" : busy ? startLabel : detectedApp ? "Connect (use detected app)" : canSyncNow ? "Sync" : "Connect"}
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
          {status?.credentialHelp ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                  How to get your {status.credentialLabel}
                </p>
                <a
                  href={status.credentialHelp.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-xs text-accent hover:underline"
                  title={status.credentialHelp.url}
                >
                  Open {new URL(status.credentialHelp.url).host} ↗
                </a>
              </div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-muted-fg">
                {status.credentialHelp.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ) : null}

          {status?.oauth ? (
            <>
              {/* The exact redirect URI the provider app must register — the one
                  thing every OAuth setup trips on, so it's front and copyable. */}
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-xs text-muted-fg">Redirect URI</span>
                <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-fg" title={redirectUri}>
                  {redirectUri}
                </code>
                <Button size="sm" variant="ghost" onClick={() => copy(redirectUri)} title="Copy the redirect URI to paste into the provider app">
                  {copied ? <Check width={13} height={13} className="text-accent" /> : <Copy width={13} height={13} />}
                  Copy
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Client ID"
                  autoComplete="off"
                  className="flex-1 font-mono"
                />
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Client Secret"
                  autoComplete="off"
                  className="flex-1 font-mono"
                />
                <Button
                  size="md"
                  variant="primary"
                  onClick={authorize}
                  disabled={working || !clientId.trim() || !clientSecret.trim()}
                  title={`Opens ${status.name}'s consent page; tokens are stored and refreshed automatically`}
                >
                  {busy ? <Spinner width={16} height={16} /> : null}
                  {busy ? "Starting…" : "Authorize"}
                </Button>
              </div>
              <p className="text-xs text-muted-fg" title="A pasted access token expires within hours — the authorize flow stores a refresh token, so scheduled syncs keep working.">
                Or paste a short-lived access token below (expires — authorize is the durable way).
              </p>
            </>
          ) : null}

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
            <Button
              size="md"
              variant="primary"
              onClick={sync}
              disabled={working || !cred}
              title="Tests the key against the real API first — only a working key is saved"
            >
              {busy ? <Spinner width={16} height={16} /> : null}
              {busy ? "Testing key…" : "Connect & sync"}
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
