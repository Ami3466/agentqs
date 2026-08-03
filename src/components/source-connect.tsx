"use client";

import { useEffect, useRef, useState } from "react";
import { useCachedFetch } from "@/lib/client-cache";
import { useCopy } from "@/components/connect-api";
import { Check, Copy, Eye, EyeOff, Spinner, Trash } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { SourceHeader } from "@/components/source-title";
import { SyncStatus } from "@/components/sync-status";
import { Button, Input } from "@/components/ui";
import { jobActive, type Interval, type SourceCoverage, type SourceJobView, type SourceProvenance } from "@/lib/sources";

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
  /** Why this API can't give its full history — shown on the row so a hard ceiling
   *  ("RescueTime only exposes ~2 weeks") never reads as a broken import. */
  historyNote: string | null;
  live: boolean;
  connected: boolean;
  hasData: boolean;
  detectedApp: boolean;
  hasCredential: boolean;
  credentialLabel: string;
  credentialPlaceholder: string;
  credentialHelp: { url: string; steps: string[] } | null;
  oauth: { supported: boolean; authorized: boolean; appSaved: boolean; clientId: string } | null;
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
  nameOverride,
  iconId,
  coverage,
  account,
  provenance,
  connectedSeed = false,
  hasDataSeed = false,
  detectedAppSeed = false,
  nameSeed,
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
  /** Live/last background job — the panel polls /api/sources and threads it here. */
  job?: SourceJobView | null;
  /** What this source landed (from /api/sources). Falls back to the row's own
   *  status GET, so a row never claims "no data yet" while holding data. */
  coverage?: SourceCoverage;
  /** The account the stored credential belongs to, when the source knows it. */
  account?: string | null;
  /** How this row got its data (from /api/sources) — decides Connected vs Imported. */
  provenance?: SourceProvenance;
  /** Shown instead of the plugin's own name. A source nested inside a provider card
   *  is a PRODUCT of it, not a service of its own: inside the Google card, `gcal` is
   *  "Calendar", not "Google Calendar" — the card already said Google. */
  nameOverride?: string;
  /** Draw a different source's mark (the provider's) — same reason. */
  iconId?: string;
  /** What /api/sources already knows about this row. The panel has the whole list
   *  in one response; a row that renders from it needs no GET of its own, which is
   *  what turned opening Pipeline into ~30 parallel scans of the record. */
  connectedSeed?: boolean;
  hasDataSeed?: boolean;
  detectedAppSeed?: boolean;
  nameSeed?: string;
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
  // "Use a different app key" — the only reason to ever show that form again.
  const [replaceKey, setReplaceKey] = useState(false);
  const [copied, copy] = useCopy();
  const handledReturn = useRef(false);
  // Cadence chosen AS PART OF connecting — defaults to Daily so a newly connected
  // API source actually auto-syncs (Manual is still selectable here).
  const [pendingInterval, setPendingInterval] = useState<Interval>("daily");

  // A row's own status GET is only worth paying for once it has something to say:
  // a live sparkline + sync state (connected / holding data), or the credential
  // form the user just opened. A dark row in a 30-source list renders entirely from
  // the panel's seed — opening Pipeline used to fire one request per row, each
  // re-reading the record, and the tab took seconds to settle because of it.
  // ...and one more case: we just came back from this source's OAuth consent page
  // (/api/oauth/callback bounces to ?source=<id>). That handoff is handled below
  // off `status`, so a not-yet-connected row must load it here or the return would
  // be silently dropped.
  const [oauthReturn] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("source") === id,
  );
  const wantStatus = connectedSeed || hasDataSeed || open || oauthReturn;
  const remote = useCachedFetch<Status>(`/api/import/${id}`, { enabled: wantStatus });
  useEffect(() => {
    if (remote.data) setStatus(remote.data);
  }, [remote.data]);
  // `version` bumps on any panel-wide mutation (a sync landed, a source was
  // removed) — that is exactly when this row's status is stale.
  useEffect(() => {
    if (version > 0 && wantStatus) void remote.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, id]);

  async function loadStatus() {
    await remote.refresh();
  }

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

  /** Register the app key — once, for the provider. NOT a login: it starts no dance,
   *  it just means we never ask for the Client ID + Secret again. */
  async function saveKey() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/oauth/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, saveOnly: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setBusy(false);
      if (!res.ok) {
        setError(data.error || `Could not save the app key (HTTP ${res.status}).`);
        return;
      }
      setClientId("");
      setClientSecret("");
      setReplaceKey(false);
      await loadStatus(); // → the form becomes a Sign-in button
    } catch (e) {
      setBusy(false);
      setError((e as Error).message || "Could not reach the app.");
    }
  }

  /** Send the browser to the provider's consent page. The app key is already saved —
   *  passing it again here would be re-doing paperwork that never expired. */
  async function authorize() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/oauth/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: window.location.origin }),
      });
      const data = (await res.json().catch(() => ({}))) as { authorizeUrl?: string; error?: string };
      if (!res.ok || !data.authorizeUrl) {
        setBusy(false);
        // Always name the real failure — a bare "could not start" hides a
        // missing route (404) or a crashed server (500) behind one string.
        setError(data.error || `Could not start the authorization (HTTP ${res.status}).`);
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

  const displayName = nameOverride ?? status?.name ?? nameSeed ?? id;
  // The panel's coverage is richer (events + date range). Without it — a product
  // nested in a provider card — fall back to the row's own day count.
  const cov: SourceCoverage | undefined =
    coverage ?? (status ? { events: 0, days: status.days, from: null, to: null } : undefined);
  // Guarded for SSR — only read once the panel is open (post-hydration anyway).
  const redirectUri = typeof window === "undefined" ? "" : `${window.location.origin}/api/oauth/callback`;
  // Seeded from the panel until this row's own GET (if any) lands, so a connected
  // row is never briefly drawn as a stranger with a Connect button.
  const connected = status?.connected ?? connectedSeed;
  const live = status?.live ?? true;
  const detectedApp = (status ? Boolean(status.detectedApp) : detectedAppSeed) && !connected;
  const canSyncNow = Boolean(status?.hasCredential) || Boolean(cred) || detectedApp;
  const working = busy || syncing;
  const startLabel = busy ? (cred ? "Testing key…" : "Starting…") : "Sync";

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        {/* An API source holding data with NO stored key is "Imported", not
            connected — the badge says so on its own now. */}
        <SourceHeader
          id={id}
          name={displayName}
          iconId={iconId}
          connected={Boolean(connected)}
          hasData={status ? Boolean(status.hasData) : hasDataSeed}
          provenance={provenance ?? (connected ? "credential" : (status?.hasData ?? hasDataSeed) ? "imported" : undefined)}
          account={account}
          coverage={cov}
          lastSync={status?.syncedAt ?? null}
        />
        <div className="flex shrink-0 items-center gap-2">
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

      {/* A hard API ceiling, stated where the user asks "why so few days?" — only
          once the source is actually pulling, or it is noise on a Connect button. */}
      {connected && status?.historyNote ? (
        <p className="mt-2 pl-12 text-xs text-muted-fg" title={status.historyNote}>
          <span className="font-medium text-fg">Why so few days?</span> {status.historyNote}
        </p>
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
              {/* THE APP KEY IS SAVED, THE LOGIN IS NOT THE SAME ACT.
                  Registering an app with the provider happens ONCE; signing in — again,
                  or as another account — must never re-ask for the Client ID + Secret.
                  With a key on file this is a Sign-in button and nothing else. */}
              {status.oauth.appSaved && !replaceKey ? (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-fg">
                      <span className="font-medium">App key saved</span>{" "}
                      <span className="font-mono text-muted-fg" title={status.oauth.clientId}>
                        {status.oauth.clientId.slice(0, 24)}…
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setReplaceKey(true)}
                      className="text-xs text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                    >
                      Use a different app key
                    </button>
                  </div>
                  <Button
                    size="md"
                    variant="primary"
                    onClick={authorize}
                    disabled={working}
                    title={`Opens ${status.name}'s consent page. The saved app key is reused — sign in as many accounts as you like.`}
                  >
                    {busy ? <Spinner width={16} height={16} /> : null}
                    {busy ? "Starting…" : `Sign in with ${status.name}`}
                  </Button>
                </div>
              ) : (
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
                      onClick={saveKey}
                      disabled={working || !clientId.trim() || !clientSecret.trim()}
                      title="Saved once for this provider — every account you add afterwards reuses it, and you are never asked for it again."
                    >
                      {busy ? <Spinner width={16} height={16} /> : null}
                      {busy ? "Saving…" : "Save key"}
                    </Button>
                  </div>
                  {replaceKey ? (
                    <button
                      type="button"
                      onClick={() => setReplaceKey(false)}
                      className="text-xs text-muted-fg underline-offset-2 hover:text-fg hover:underline"
                    >
                      Keep the saved key
                    </button>
                  ) : null}
                </>
              )}
              <p className="text-xs text-muted-fg" title="A pasted access token expires within hours — the authorize flow stores a refresh token, so scheduled syncs keep working.">
                Or paste a short-lived access token below (expires — signing in is the durable way).
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
