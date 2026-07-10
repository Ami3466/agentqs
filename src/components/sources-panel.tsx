"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Inbox, Plus, RefreshCw, sourceIcon, Spinner, Trash, X } from "@/components/icons";
import { GithubConnect } from "@/components/github-connect";
import { WhoopConnect } from "@/components/whoop-connect";
import { SourceConnect } from "@/components/source-connect";
import { AutomationSetup } from "@/components/automation-setup";
import { AutomationRow } from "@/components/automation-row";
import { IntervalSelect } from "@/components/interval-select";
import { Badge, Button, cn, Input, TabBar } from "@/components/ui";
import { jobActive, type Interval, type SourceView } from "@/lib/sources";

type Tab = "connections" | "automated";

type GoogleImportStatus = {
  exists: boolean;
  days: number;
  from: string | null;
  to: string | null;
  events: number;
  updatedAt: string | null;
};

type ChromeImporterStatus = {
  extensionDir: string;
  downloadUrl: string;
  extensionSeenAt: string | null;
  extensionVersion: string;
  latestVersion: string;
  imports: Array<{
    id: string;
    label: string;
    detail: string;
    source: string;
    page: string;
    retired: string | null;
    status: GoogleImportStatus;
  }>;
};

/**
 * The Pipeline-tab Sources card. One fetcher/persister of /api/sources, split into two
 * tabs by acquisition path:
 *   • Connections       — API integrations, connected or not.
 *   • Automated imports — everything the server ingests without an API key: the
 *     Chrome-extension Google presets, Playwright/scraping automations, and
 *     record-backed imports (Chrome history file, Google archives, other CSVs).
 * Connected = the user authorized syncing (credential / opted-in detected app);
 * data presence is a separate fact (hasData) and never implies connected (derived,
 * never faked). Also owns lazy-sync-on-open: on mount it POSTs every DUE api source,
 * then bumps the shared `version` so downstream panels refetch.
 */
export function SourcesPanel({
  version,
  onChanged,
}: {
  version: number;
  onChanged: () => void;
}) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [tab, setTab] = useState<Tab>("connections");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [chromeStatus, setChromeStatus] = useState<ChromeImporterStatus | null>(null);
  const [chromeStatusError, setChromeStatusError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [autoMsg, setAutoMsg] = useState("");
  const [autoFailed, setAutoFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Extra-account rows being set up (instance ids like "spotify-2") — ephemeral
  // until a credential is saved, then /api/sources owns them.
  const [addingAccounts, setAddingAccounts] = useState<string[]>([]);
  // The automation wizard records scraping/browser automation recipes.
  const [wizardSeed, setWizardSeed] = useState<{ name?: string; url?: string } | null>(null);
  const openWizard = useCallback((seed: { name?: string; url?: string } = {}) => {
    setTab("automated");
    setWizardSeed(seed);
  }, []);
  const ranAuto = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const wizardRef = useRef<HTMLDivElement>(null);

  // Bring the freshly opened wizard into view instead of yanking the page to the top.
  useEffect(() => {
    if (wizardSeed !== null) wizardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [wizardSeed]);

  const load = useCallback(async (): Promise<SourceView[] | null> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      setSourceError("");
      const res = await fetch("/api/sources", { signal: controller.signal });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Could not load sources (${res.status}).`);
      }
      const data = (await res.json()) as { sources: SourceView[] };
      setSources(data.sources);
      return data.sources;
    } catch (e) {
      setSourceError((e as Error).name === "AbortError" ? "Sources took too long to load. Restart AgentQS and try again." : (e as Error).message);
      setSources([]);
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  const loadChromeStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/automations/google-activity-extension/status");
      if (!res.ok) throw new Error(`Google import status failed (${res.status}).`);
      setChromeStatus((await res.json()) as ChromeImporterStatus);
      setChromeStatusError("");
    } catch (e) {
      setChromeStatusError((e as Error).message || "Could not load Google import status.");
    }
  }, []);

  useEffect(() => {
    void loadChromeStatus();
  }, [loadChromeStatus]);

  useEffect(() => {
    if (tab !== "automated") return;
    void loadChromeStatus();
    const id = window.setInterval(() => void loadChromeStatus(), 5000);
    return () => window.clearInterval(id);
  }, [tab, loadChromeStatus]);

  // Load on mount + whenever the shared version bumps. The first load also fires
  // lazy-sync-on-open for any due api source (guarded so it runs exactly once).
  // The POSTs return immediately (202 — the syncs run as background jobs on the
  // server); the job poller below tracks them to completion.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await load();
      if (cancelled || ranAuto.current) return;
      ranAuto.current = true;
      const due = (list ?? []).filter((s) => s.due && s.syncEndpoint);
      if (!due.length) return;
      setSyncing(true);
      setAutoMsg(`Syncing ${due.map((d) => d.name).join(", ")} in the background…`);
      await Promise.all(
        due.map((s) =>
          fetch(s.syncEndpoint as string, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }).catch(() => undefined),
        ),
      );
      if (cancelled) return;
      await load(); // pick up the queued jobs → the poller takes over
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Background-job poller: while any source has a queued/running sync job,
  // refetch every 2s so the rows' progress bars advance — server state, so a
  // reload resumes exactly where the import is. On the active→idle transition,
  // announce the outcome (failures BY NAME — they also persist per row) and
  // bump the shared version so downstream panels pick up the landed data.
  const activeJobs = (sources ?? []).filter((s) => jobActive(s.job));
  const anyJobActive = activeJobs.length > 0;
  const wasActive = useRef(false);
  useEffect(() => {
    if (!anyJobActive) return;
    setSyncing(true);
    setAutoMsg(`Syncing ${activeJobs.map((s) => s.name).join(", ")} in the background…`);
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyJobActive, activeJobs.map((s) => s.id).join(",")]);
  useEffect(() => {
    if (wasActive.current && !anyJobActive) {
      setSyncing(false);
      const failed = (sources ?? []).filter((s) => s.job?.status === "error");
      setAutoFailed(failed.length > 0);
      setAutoMsg(
        failed.length
          ? `Sync failed for ${failed.map((s) => s.name).join(", ")} — see the row for the reason.`
          : "Background sync finished.",
      );
      onChanged(); // bump → downstream refetch (version effect)
      window.setTimeout(() => {
        setAutoMsg("");
        setAutoFailed(false);
      }, 8000);
    }
    wasActive.current = anyJobActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyJobActive]);

  async function changeInterval(id: string, interval: Interval) {
    setSavingId(id);
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, interval }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sources: SourceView[] };
        setSources(data.sources);
      }
    } finally {
      setSavingId(null);
    }
  }

  async function removeSource(id: string) {
    setRemovingId(id);
    setRemoveError("");
    try {
      const res = await fetch("/api/sources", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sources: SourceView[] };
        setSources(data.sources);
        void loadChromeStatus(); // a removed Google preset leaves the card too
        onChanged(); // its rows leave the daily table too
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setRemoveError(data.error || `Could not remove ${id}.`);
      }
    } catch (e) {
      setRemoveError((e as Error).message || `Could not remove ${id}.`);
    } finally {
      setRemovingId(null);
    }
  }

  // Split by acquisition path. Connections = API integrations. Automated imports =
  // the Google-extension presets + scraping automations, with every record-backed
  // import (file/archive CSVs) grouped into ONE collapsible, searchable box —
  // a lifetime record holds dozens of sources and flat rows would drown the tab.
  const all = sources ?? [];
  const byConnected = (a: SourceView, b: SourceView) => Number(b.connected) - Number(a.connected);
  const connections = all.filter((s) => s.kind === "api" && !s.automation).sort(byConnected);
  const automations = all.filter((s) => s.automation).sort(byConnected);
  const importedData = all
    .filter((s) => !s.automation && s.kind !== "api")
    .sort((a, b) => a.name.localeCompare(b.name));
  const list = tab === "automated" ? automations : connections;
  const googleImportsLanded = (chromeStatus?.imports ?? []).filter((item) => item.status.exists).length;
  // The badge counts ACTIVE automated pipelines (recorded automations + landed
  // Google-extension imports). Manual file/archive imports live in the Imported
  // data group on this tab but are not automated — never count them here.
  const automatedCount = automations.filter((s) => s.connected).length + googleImportsLanded;

  // Multi-account: a connected plugin source can be connected AGAIN under a new
  // instance id ("spotify-2"). Ephemeral rows live here until the credential is
  // saved server-side, then /api/sources lists them and the local copy drops.
  const knownIds = new Set(all.map((s) => s.id));
  const pendingAccounts = addingAccounts.filter((id) => !knownIds.has(id));
  const accountBases = connections.filter((s) => s.connected && s.plugin && !/-\d+$/.test(s.id));

  function addAccount(baseId: string) {
    const re = new RegExp(`^${baseId}-(\\d+)$`);
    let max = 1; // the base connection is account 1
    for (const id of [...knownIds, ...addingAccounts]) {
      const m = id.match(re);
      if (m) max = Math.max(max, Number(m[1]));
    }
    setAddingAccounts((a) => [...a, `${baseId}-${max + 1}`]);
  }

  function row(s: SourceView) {
    const saving = savingId === s.id;
    const removing = removingId === s.id;
    // Removable when there is anything to remove — landed data or a credential.
    const onRemove = s.connected || s.hasData ? () => void removeSource(s.id) : undefined;
    const onIntervalChange = (i: Interval) => void changeInterval(s.id, i);

    if (s.automation) {
      return (
        <AutomationRow
          key={s.id}
          source={s}
          saving={saving}
          removing={removing}
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
          onRan={() => {
            void load();
            onChanged();
          }}
        />
      );
    }
    // `job` threads the panel's freshly polled background-job state into the row
    // (live progress bar); `onSyncStarted` makes a row-initiated sync visible to
    // the poller right away.
    if (s.id === "github") {
      return (
        <GithubConnect
          key={s.id}
          version={version}
          interval={s.interval}
          due={s.due}
          savingInterval={saving}
          removing={removing}
          job={s.job ?? null}
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
          onSyncStarted={() => void load()}
        />
      );
    }
    if (s.id === "whoop") {
      return (
        <WhoopConnect
          key={s.id}
          version={version}
          interval={s.interval}
          due={s.due}
          savingInterval={saving}
          removing={removing}
          job={s.job ?? null}
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
          onSyncStarted={() => void load()}
        />
      );
    }
    if (s.kind === "api") {
      return (
        <SourceConnect
          key={s.id}
          id={s.id}
          version={version}
          interval={s.interval}
          due={s.due}
          savingInterval={saving}
          removing={removing}
          credentialOrigin={s.credentialOrigin ?? null}
          job={s.job ?? null}
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
          onSyncStarted={() => void load()}
        />
      );
    }
    return (
      <SourceRow
        key={s.id}
        source={s}
        saving={saving}
        removing={removing}
        onIntervalChange={onIntervalChange}
        onRemove={onRemove}
        onConnect={() => openWizard({ name: s.name })}
      />
    );
  }

  return (
    <div ref={rootRef} className="scroll-mt-4">
      <div className="border-b border-border p-4">
        <TabBar<Tab>
          tabs={[
            { value: "connections", label: "Connections", count: connections.filter((s) => s.connected).length },
            { value: "automated", label: "Automated imports", count: automatedCount },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {autoMsg ? (
        <div
          className={cn(
            "flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs",
            autoFailed ? "bg-destructive/5 text-destructive" : "text-accent",
          )}
        >
          {syncing ? <Spinner width={13} height={13} /> : autoFailed ? <X width={13} height={13} /> : <Check width={13} height={13} />}
          {autoMsg}
        </div>
      ) : null}
      {removeError ? (
        <div className="border-b border-border bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {removeError}
        </div>
      ) : null}
      {sourceError ? (
        <div className="border-b border-border bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {sourceError}
        </div>
      ) : null}
      {sources === null ? (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-fg">
          <Spinner width={13} height={13} /> Loading…
        </div>
      ) : (
        <>
          {tab === "automated" ? (
            <div className="divide-y divide-border">
              <GoogleImporterCard
                status={chromeStatus}
                error={chromeStatusError}
                removingId={removingId}
                onRemove={(id) => void removeSource(id)}
              />
            </div>
          ) : null}

          {list.length ? <div className="divide-y divide-border">{list.map(row)}</div> : null}

          {tab === "automated" && importedData.length ? (
            <ImportedDataGroup sources={importedData} renderRow={row} />
          ) : null}

          {tab === "connections" && pendingAccounts.length ? (
            <div className="divide-y divide-border border-t border-border">
              {pendingAccounts.map((id) => (
                <div key={id}>
                  <div className="flex items-center justify-between px-4 pt-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                      New account
                    </span>
                    <button
                      type="button"
                      onClick={() => setAddingAccounts((a) => a.filter((x) => x !== id))}
                      className="rounded p-1 text-muted-fg hover:text-fg"
                      aria-label="Cancel new account"
                    >
                      <X width={14} height={14} />
                    </button>
                  </div>
                  <SourceConnect
                    id={id}
                    version={version}
                    onIntervalChange={(i) => void changeInterval(id, i)}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {tab === "connections" && accountBases.length ? (
            <div className="border-t border-border p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
                Add another account
              </p>
              <p className="mt-0.5 text-xs text-muted-fg">
                Already connected — link a second account with its own key and schedule.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {accountBases.map((s) => (
                  <Button key={s.id} size="sm" variant="secondary" onClick={() => addAccount(s.id)}>
                    <Plus width={13} height={13} /> {s.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {wizardSeed !== null ? (
            <div ref={wizardRef} className="scroll-mt-4">
              <AutomationSetup
                initialName={wizardSeed.name ?? ""}
                initialUrl={wizardSeed.url ?? ""}
                onCancel={() => setWizardSeed(null)}
                onDone={() => {
                  setWizardSeed(null);
                  setTab("automated");
                  void load();
                  onChanged();
                }}
              />
            </div>
          ) : tab === "automated" ? (
            <button
              type="button"
              onClick={() => openWizard()}
              className="flex w-full items-center gap-3 border-t border-border p-4 text-left transition-colors hover:bg-muted/40"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted text-muted-fg">
                <RefreshCw width={17} height={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">Custom scraping</p>
                <p className="truncate text-xs text-muted-fg">Record a click-path on any site and replay it on a schedule</p>
              </div>
              <span className="shrink-0 text-xs font-medium text-muted-fg">Set up →</span>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The predone Google scraping presets, one row per preset. Data flows through the
 * Chrome extension: install it once, open a preset's Google page, press
 * "Start import" in the AgentQS panel there. Each preset lands in its own source
 * (daily rollup + events), shows its coverage here, and is removable per preset.
 */
function GoogleImporterCard({
  status,
  error,
  removingId,
  onRemove,
}: {
  status: ChromeImporterStatus | null;
  error: string;
  removingId: string | null;
  onRemove: (sourceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const imports = status?.imports ?? [];
  const landed = imports.filter((item) => item.status.exists);
  const pending = imports.filter((item) => !item.status.exists);
  const totalEvents = landed.reduce((sum, item) => sum + item.status.events, 0);
  // The extension pings the server every ~5 minutes while installed; a stamp older
  // than that (or none) means clicking a Google page would silently do nothing, so
  // the card teaches the install steps instead.
  const extensionOnline = Boolean(
    status?.extensionSeenAt && Date.now() - new Date(status.extensionSeenAt).getTime() < 6 * 60 * 1000,
  );
  // Unpacked extensions never auto-update — a version behind the one this app
  // ships is the only signal the user gets to replace the folder and reload.
  const extensionOutdated = Boolean(
    extensionOnline && status?.latestVersion && status?.extensionVersion && status.extensionVersion !== status.latestVersion,
  );
  // All imported presets always show; the not-yet-imported tail fills the card up
  // to ~6 rows, the rest sits behind "Show all" so the card doesn't drown the tab.
  const fillCount = Math.max(0, 6 - landed.length);
  const visible = expanded ? [...landed, ...pending] : [...landed, ...pending.slice(0, fillCount)];
  const hiddenCount = imports.length - visible.length;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-fg">
          <RefreshCw width={17} height={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Google data · Chrome extension</p>
          <p className="truncate text-xs text-muted-fg">
            {landed.length
              ? `${totalEvents.toLocaleString()} events across ${landed.length} import${landed.length === 1 ? "" : "s"}`
              : "Search, YouTube, Maps, Chrome, Timeline and more"}
            {extensionOnline ? ` · extension connected${status?.extensionVersion ? ` (v${status.extensionVersion})` : ""}` : ""}
          </p>
        </div>
        <Button
          size="sm"
          variant={extensionOnline && !extensionOutdated ? "secondary" : "primary"}
          onClick={() => window.open(status?.downloadUrl ?? "/downloads/agentqs-google-activity-exporter.zip", "_blank", "noopener,noreferrer")}
        >
          {extensionOnline ? "Update extension" : "Download extension"}
        </Button>
      </div>

      {extensionOutdated ? (
        <p
          className="mt-2 truncate text-xs text-destructive"
          title={`Installed v${status?.extensionVersion} is missing fixes from v${status?.latestVersion}. Download the zip, replace the unpacked extension folder with its contents, then press Reload on chrome://extensions — unpacked extensions never update themselves.`}
        >
          Extension v{status?.extensionVersion} is outdated — v{status?.latestVersion} available. Download, replace the folder, then Reload it on chrome://extensions.
        </p>
      ) : null}
      {extensionOnline ? (
        <p className="mt-2 text-xs text-muted-fg">
          Press <span className="font-medium text-fg">Import</span> on a row: the Google page opens and the import starts in the
          AgentQS panel there. Long histories resume automatically.
        </p>
      ) : (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-fg">
          <li>Download the extension zip and unzip it.</li>
          <li>Open <span className="font-mono text-[11px] text-fg">chrome://extensions</span>, turn on Developer mode, click <span className="font-medium text-fg">Load unpacked</span> and pick the unzipped folder.</li>
          <li>This card shows "extension connected" within a minute; then press Import on any row below.</li>
        </ol>
      )}

      {error ? (
        <div className="mt-3 rounded-md border border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
      ) : null}

      {imports.length ? (
        <div className="mt-3 divide-y divide-border rounded-md border border-border">
          {visible.map((item) => {
            const removing = removingId === item.source;
            return (
              <div key={item.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-fg">{item.label}</p>
                  <p className="truncate text-xs text-muted-fg">
                    {item.status.exists
                      ? (item.status.events > 0 ? `${item.status.events.toLocaleString()} events · ` : "") +
                        `${item.status.days.toLocaleString()} days` +
                        (item.status.from ? ` · ${item.status.from} → ${item.status.to}` : "")
                      : item.detail}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {item.retired ? (
                    <Badge title={item.retired}>phone export only</Badge>
                  ) : (
                  <Button
                    size="sm"
                    variant={item.status.exists ? "ghost" : "secondary"}
                    onClick={() => {
                      // #agentqs-import=<preset> auto-starts the import once the
                      // extension's panel loads on the Google page.
                      const target = `${item.page}${item.page.includes("#") ? "" : `#agentqs-import=${item.id}`}`;
                      window.open(target, "_blank", "noopener,noreferrer");
                    }}
                    title={
                      extensionOnline
                        ? `Open ${item.label} on Google and start the import there`
                        : `Install the extension first, then this opens ${item.label} and starts the import`
                    }
                  >
                    {item.status.exists ? "Update" : "Import"}
                  </Button>
                  )}
                  {item.status.exists ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const ok = window.confirm(
                          `Remove ${item.label}? This deletes ${item.status.events.toLocaleString()} imported events across ${item.status.days.toLocaleString()} days. Re-importing takes a full new run.`,
                        );
                        if (ok) onRemove(item.source);
                      }}
                      disabled={removing}
                      title={`Remove ${item.label} data`}
                    >
                      {removing ? <Spinner width={14} height={14} /> : <Trash width={14} height={14} />}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {hiddenCount > 0 || expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-full px-3 py-2 text-left text-xs font-medium text-muted-fg transition-colors hover:text-fg"
            >
              {expanded ? "Show fewer" : `Show all ${imports.length} Google imports`}
            </button>
          ) : null}
        </div>
      ) : !error ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/25 px-3 py-2 text-xs text-muted-fg">
          <Spinner width={13} height={13} /> Loading Google import status…
        </div>
      ) : null}
    </div>
  );
}

/** All record-backed imports (merged CSVs, file imports, archive bundles) in one
 *  collapsible box: a count when closed; searchable and scrollable when open. */
function ImportedDataGroup({
  sources,
  renderRow,
}: {
  sources: SourceView[];
  renderRow: (s: SourceView) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sources.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    : sources;
  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-fg">
          <Inbox width={17} height={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Imported data</p>
          <p className="truncate text-xs text-muted-fg">
            {sources.length.toLocaleString()} source{sources.length === 1 ? "" : "s"} from files, archives and merges
          </p>
        </div>
        <ChevronDown
          width={15}
          height={15}
          className={cn("shrink-0 text-muted-fg transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div className="border-t border-border">
          {sources.length > 6 ? (
            <div className="border-b border-border p-3">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search imported sources"
                className="h-8 text-[13px]"
              />
            </div>
          ) : null}
          <div className="max-h-80 divide-y divide-border overflow-y-auto">
            {filtered.length ? (
              filtered.map(renderRow)
            ) : (
              <p className="p-4 text-xs text-muted-fg">No source matches "{query}".</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Minimal row for imported files/archives. Connected rows expose interval + Remove. */
function SourceRow({
  source,
  saving,
  removing,
  onIntervalChange,
  onRemove,
  onConnect,
}: {
  source: SourceView;
  saving: boolean;
  removing: boolean;
  onIntervalChange: (i: Interval) => void;
  onRemove?: () => void;
  onConnect?: () => void;
}) {
  const { id, name, connected, stale, interval } = source;
  const Icon = sourceIcon(id);
  return (
    <div className="flex items-center gap-3 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
        <Icon width={18} height={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-fg">{name}</p>
          {stale ? (
            <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
              stale
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {connected ? (
          <>
            {saving ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
            <IntervalSelect value={interval} onChange={onIntervalChange} disabled={saving} />
            {onRemove ? (
              <Button size="sm" variant="ghost" onClick={onRemove} disabled={removing} title="Remove">
                {removing ? <Spinner width={14} height={14} /> : <Trash width={14} height={14} />}
                Remove
              </Button>
            ) : null}
          </>
        ) : (
          <Button size="sm" variant="primary" onClick={onConnect}>
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}
