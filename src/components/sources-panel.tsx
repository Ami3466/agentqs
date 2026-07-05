"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Spinner } from "@/components/icons";
import { GithubConnect } from "@/components/github-connect";
import { IntervalSelect } from "@/components/interval-select";
import { Badge, cn } from "@/components/ui";
import { ago, type Interval, type SourceView } from "@/lib/sources";

/**
 * The Data-tab sources list + sync engine (Loop 10). Single fetcher/persister of
 * /api/sources: renders every source (GitHub via the rich GithubConnect row, the
 * rest via a generic row), owns the per-source interval dropdowns, and runs
 * lazy-sync-on-open — on mount it POSTs every DUE api source's endpoint, then
 * bumps the shared `version` so the daily preview refetches. Manual sources that
 * fall behind their interval show a stale badge (they can't auto-sync).
 */
export function SourcesPanel({
  version,
  onChanged,
}: {
  version: number;
  onChanged: () => void;
}) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const ranAuto = useRef(false);

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

  const github = sources?.find((s) => s.id === "github");
  const others = (sources ?? []).filter((s) => s.id !== "github");

  return (
    <div>
      {autoMsg ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-accent">
          {syncing ? <Spinner width={13} height={13} /> : <Check width={13} height={13} />}
          {autoMsg}
        </div>
      ) : null}

      <div className="divide-y divide-border">
        <GithubConnect
          version={version}
          interval={github?.interval ?? "off"}
          due={Boolean(github?.due)}
          savingInterval={savingId === "github"}
          onIntervalChange={(i) => changeInterval("github", i)}
        />

        {others.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            saving={savingId === s.id}
            onIntervalChange={(i) => changeInterval(s.id, i)}
          />
        ))}
      </div>
    </div>
  );
}

/** Generic (non-GitHub) source row: manual sources discovered in the record and
 *  not-yet-live integrations. Connected sources get an interval dropdown; overdue
 *  manual sources get a stale badge. */
function SourceRow({
  source,
  saving,
  onIntervalChange,
}: {
  source: SourceView;
  saving: boolean;
  onIntervalChange: (i: Interval) => void;
}) {
  const { name, kind, detail, connected, lastSync, stale, interval } = source;
  return (
    <div className="flex items-center gap-3 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold uppercase text-muted-fg">
        {name.charAt(0)}
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
      <div className="shrink-0">
        {connected ? (
          <div className="flex items-center gap-1.5">
            {saving ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
            <IntervalSelect value={interval} onChange={onIntervalChange} disabled={saving} />
          </div>
        ) : (
          <span className="text-xs text-muted-fg">not connected</span>
        )}
      </div>
    </div>
  );
}
