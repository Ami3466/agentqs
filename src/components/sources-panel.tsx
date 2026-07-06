"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Plus, RefreshCw, sourceIcon, Spinner, Trash, X } from "@/components/icons";
import { GithubConnect } from "@/components/github-connect";
import { WhoopConnect } from "@/components/whoop-connect";
import { SourceConnect } from "@/components/source-connect";
import { AutomationSetup } from "@/components/automation-setup";
import { AutomationRow } from "@/components/automation-row";
import { IntervalSelect } from "@/components/interval-select";
import { Button, cn } from "@/components/ui";
import { type Interval, type SourceView } from "@/lib/sources";

type Tab = "connections" | "automated";

/**
 * The Data-tab Sources card. One fetcher/persister of /api/sources, split into two
 * tabs BY TYPE (a source never moves between them when it connects):
 *   • Connections     — API integrations (GitHub, WHOOP, Tier-1 plugins + extra
 *                       accounts). Connected rows edit their interval / Remove here.
 *   • Automated imports — the no-API lane: browser-automation recipes, local file
 *                       feeds, the no-API roster (Connect opens the wizard), and the
 *                       "automate a site without an API" entry.
 * A source is only shown as connected when its record actually has rows (derived,
 * never faked). Also owns lazy-sync-on-open: on mount it POSTs every DUE api source,
 * then bumps the shared `version` so downstream panels refetch.
 */
export function SourcesPanel({
  version,
  onChanged,
  automateSignal = 0,
}: {
  version: number;
  onChanged: () => void;
  /** Incremented by the inbox "Automate imports" button — opens the setup wizard in
   *  the Automated imports tab. */
  automateSignal?: number;
}) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [tab, setTab] = useState<Tab>("connections");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  // Extra-account rows being set up (instance ids like "spotify-2") — ephemeral
  // until a credential is saved, then /api/sources owns them.
  const [addingAccounts, setAddingAccounts] = useState<string[]>([]);
  // The automation wizard, optionally seeded from a specific roster source. It lives
  // under Automated imports (it becomes one), so opening it lands the user there.
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
    const res = await fetch("/api/sources");
    if (!res.ok) return null;
    const data = (await res.json()) as { sources: SourceView[] };
    setSources(data.sources);
    return data.sources;
  }, []);

  // Load on mount + whenever the shared version bumps. The first load also fires
  // lazy-sync-on-open for any due api source (guarded so it runs exactly once).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await load();
      if (cancelled || ranAuto.current) return;
      ranAuto.current = true;
      const due = (list ?? []).filter((s) => s.due && s.syncEndpoint);
      if (!due.length) return;
      setSyncing(true);
      setAutoMsg(`Auto-syncing ${due.map((d) => d.name).join(", ")}…`);
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
      setSyncing(false);
      setAutoMsg(`Auto-synced ${due.map((d) => d.name).join(", ")} on open.`);
      onChanged(); // bump → downstream refetch (version effect)
      window.setTimeout(() => setAutoMsg(""), 6000);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Inbox "Automate imports" → jump to the Automated tab and open the wizard.
  useEffect(() => {
    if (!automateSignal) return;
    setTab("automated");
    openWizard();
  }, [automateSignal, openWizard]);

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
    try {
      const res = await fetch("/api/sources", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sources: SourceView[] };
        setSources(data.sources);
        onChanged(); // its rows leave the daily table too
      }
    } finally {
      setRemovingId(null);
    }
  }

  // Split by type: API integrations stay under Connections for good; everything
  // driven without an API (automations, file feeds, no-API roster) is Automated.
  const all = sources ?? [];
  const byConnected = (a: SourceView, b: SourceView) => Number(b.connected) - Number(a.connected);
  const connections = all.filter((s) => s.kind === "api" && !s.automation).sort(byConnected);
  const automated = all.filter((s) => s.automation || s.kind !== "api").sort(byConnected);
  const list = tab === "automated" ? automated : connections;

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
    // Any connected row can be removed in place — sources don't switch tabs.
    const onRemove = s.connected ? () => void removeSource(s.id) : undefined;
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
    if (s.id === "github") {
      return (
        <GithubConnect
          key={s.id}
          version={version}
          interval={s.interval}
          due={s.due}
          savingInterval={saving}
          removing={removing}
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
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
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
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
          onIntervalChange={onIntervalChange}
          onRemove={onRemove}
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
        onConnect={() => openWizard({ name: s.name, url: s.setupUrl })}
      />
    );
  }

  return (
    <div ref={rootRef} className="scroll-mt-4">
      <div className="border-b border-border p-4">
        <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-[13px]">
          <TabButton active={tab === "connections"} onClick={() => setTab("connections")}>
            Connections
            <TabCount>{connections.filter((s) => s.connected).length}</TabCount>
          </TabButton>
          <TabButton active={tab === "automated"} onClick={() => setTab("automated")}>
            Automated imports
            <TabCount>{automated.filter((s) => s.connected).length}</TabCount>
          </TabButton>
        </div>
      </div>

      {autoMsg ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-accent">
          {syncing ? <Spinner width={13} height={13} /> : <Check width={13} height={13} />}
          {autoMsg}
        </div>
      ) : null}

      {sources === null ? (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-fg">
          <Spinner width={13} height={13} /> Loading…
        </div>
      ) : (
        <>
          {list.length ? <div className="divide-y divide-border">{list.map(row)}</div> : null}

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
              <p className="min-w-0 flex-1 text-sm font-medium text-fg">Automate a site without an API</p>
              <span className="shrink-0 text-xs font-medium text-muted-fg">Set up →</span>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
        active ? "bg-card text-fg shadow-sm" : "text-muted-fg hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function TabCount({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-fg">
      {children}
    </span>
  );
}

/** Minimal source row for the no-API roster and any generic connected source, both
 *  under Automated imports. Connect opens the record-login + scrape wizard; the row
 *  matches the layout of the API rows (icon · name · one primary action). Connected
 *  rows expose interval + Remove. Stale is monochrome. */
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
