"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Plug, sourceIcon, Spinner, Trash } from "@/components/icons";
import { GithubConnect } from "@/components/github-connect";
import { SourceConnect } from "@/components/source-connect";
import { IntervalSelect } from "@/components/interval-select";
import { Badge, Button, cn } from "@/components/ui";
import { ago, type Interval, type SourceView } from "@/lib/sources";

type Tab = "connections" | "automated";

/**
 * The Data-tab Sources card (Loop 10 + two-tab redesign). One fetcher/persister of
 * /api/sources, split into two tabs under the dropzone:
 *   • Connections     — browse + connect every available integration (the catalog
 *                        of what you *can* wire up). A source lives here until it
 *                        has data.
 *   • Automated imports — the ones you've set up: status, last sync, interval
 *                        (editable) + Remove. A source lands here once connected.
 * No source is ever shown as a fake "connected" row — the split is derived from the
 * real record (`connected`). Also owns lazy-sync-on-open: on mount it POSTs every
 * DUE api source, then bumps the shared `version` so the daily preview refetches.
 */
export function SourcesPanel({
  version,
  onChanged,
  automateSignal = 0,
}: {
  version: number;
  onChanged: () => void;
  /** Incremented by the inbox "Automate imports" button — opens the setup flow by
   *  focusing the Connections catalog here and scrolling it into view. */
  automateSignal?: number;
}) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [tab, setTab] = useState<Tab>("connections");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [flowHint, setFlowHint] = useState(false);
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
      onChanged(); // bump → daily preview + this list refetch (version effect)
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

  // Automation setup flow entry: on each signal bump, jump to the Connections
  // catalog (where you wire up a recurring feed), scroll it into view, and nudge.
  useEffect(() => {
    if (!automateSignal) return;
    setTab("connections");
    setFlowHint(true);
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const t = window.setTimeout(() => setFlowHint(false), 8000);
    return () => window.clearTimeout(t);
  }, [automateSignal]);

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
      />
    );
  }

  return (
    <div ref={rootRef} className="scroll-mt-4">
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-2">
          <Plug width={16} height={16} className="text-muted-fg" />
          <p className="text-sm font-semibold text-fg">Sources</p>
        </div>
        <p className="mt-1 text-xs text-muted-fg">
          Connect an integration, then schedule how often it pulls. Feeds sync on their
          own; a dropped file just lands in the inbox above.
        </p>

        <div className="mt-3 inline-flex rounded-lg border border-border bg-muted p-0.5 text-[13px]">
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

      {flowHint && tab === "connections" ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2.5 text-xs text-fg">
          <Plug width={13} height={13} className="text-muted-fg" />
          Pick a source below to connect it and schedule how often it imports — no more
          dropping files by hand.
        </div>
      ) : null}

      {autoMsg ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-accent">
          {syncing ? <Spinner width={13} height={13} /> : <Check width={13} height={13} />}
          {autoMsg}
        </div>
      ) : null}

      {sources === null ? (
        <div className="flex items-center gap-2 p-4 text-xs text-muted-fg">
          <Spinner width={13} height={13} /> Loading sources…
        </div>
      ) : list.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-fg">
          {tab === "automated"
            ? "No automated imports yet. Connect a source under Connections to start a feed."
            : "Every available integration is already connected."}
        </p>
      ) : (
        <div className="divide-y divide-border">{list.map(row)}</div>
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

/** Generic (non-GitHub, non-plugin) source row: Tier-2 file importers + not-yet-live
 *  integrations. Connected rows show last-sync + an interval dropdown + Remove;
 *  overdue ones badge stale. Not-connected rows sit in the Connections catalog with
 *  how-to-connect context (local file → CLI; stub → soon). */
function SourceRow({
  source,
  saving,
  removing,
  onIntervalChange,
  onRemove,
}: {
  source: SourceView;
  saving: boolean;
  removing: boolean;
  onIntervalChange: (i: Interval) => void;
  onRemove?: () => void;
}) {
  const { id, name, kind, detail, connected, lastSync, stale, interval, live } = source;
  const Icon = sourceIcon(id);
  return (
    <div className="flex items-center gap-3 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-fg">
        <Icon width={18} height={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-fg">{name}</p>
          <Badge>{kind}</Badge>
          {stale ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning"
              title={`No fresh data within its ${interval} interval — refresh this source.`}
            >
              <AlertTriangle width={11} height={11} /> stale
            </span>
          ) : connected ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
              <Check width={12} height={12} /> connected
            </span>
          ) : !live ? (
            <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
              soon
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-fg">
          {connected ? (
            <span className="inline-flex items-center gap-1">
              <Clock width={11} height={11} /> updated {ago(lastSync)}
            </span>
          ) : (
            detail
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {connected ? (
          <>
            {saving ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
            <IntervalSelect value={interval} onChange={onIntervalChange} disabled={saving} />
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
        ) : live ? (
          <span
            className="text-xs text-muted-fg"
            title={`Local source — import with: agentqs source file ${id}`}
          >
            local · CLI
          </span>
        ) : (
          <span className="text-xs text-muted-fg">not yet available</span>
        )}
      </div>
    </div>
  );
}
