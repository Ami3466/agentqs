"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw, sourceIcon, Spinner, Trash } from "@/components/icons";
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
 * tabs under the dropzone:
 *   • Connections     — the catalog of integrations you can wire up. A source lives
 *                       here until it has data.
 *   • Automated imports — the ones set up: interval (editable) + Remove, plus the
 *                       "automate a site without an API" wizard entry.
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
  // The automation wizard, optionally seeded from a specific roster source.
  const [wizardSeed, setWizardSeed] = useState<{ name?: string; url?: string } | null>(null);
  const openWizard = useCallback((seed: { name?: string; url?: string } = {}) => {
    setWizardSeed(seed);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const ranAuto = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Once real data exists, land on Automated imports so the user sees their feeds.
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !sources) return;
    settled.current = true;
    if (sources.some((s) => s.connected)) setTab("automated");
  }, [sources]);

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

  const connected = (sources ?? []).filter((s) => s.connected);
  const available = (sources ?? []).filter((s) => !s.connected);
  const list = tab === "automated" ? connected : available;
  // In the Automated tab, connected rows can be edited (interval) + removed.
  const withRemove = tab === "automated";

  function row(s: SourceView) {
    const saving = savingId === s.id;
    const removing = removingId === s.id;
    const onRemove = withRemove ? () => void removeSource(s.id) : undefined;
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
            <TabCount>{available.length}</TabCount>
          </TabButton>
          <TabButton active={tab === "automated"} onClick={() => setTab("automated")}>
            Automated imports
            <TabCount>{connected.length}</TabCount>
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
          {list.length ? (
            <div className="divide-y divide-border">{list.map(row)}</div>
          ) : tab === "automated" ? null : (
            <p className="p-6 text-center text-xs text-muted-fg">All connected.</p>
          )}

          {wizardSeed !== null ? (
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

/** Minimal source row for a not-yet-live roster integration (Connections) and any
 *  generic connected source (Automated). Connect opens the record-login + scrape
 *  wizard; connected rows expose interval + Remove. Stale is monochrome. */
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
          <>
            <Button size="sm" variant="secondary" onClick={onConnect}>
              Connect
            </Button>
            <IntervalSelect value={interval} onChange={onIntervalChange} disabled={saving} />
          </>
        )}
      </div>
    </div>
  );
}
