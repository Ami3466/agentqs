"use client";

import { useState } from "react";
import { AlertTriangle, Check, Clock, Play, RefreshCw, Spinner, Trash } from "@/components/icons";
import { IntervalSelect } from "@/components/interval-select";
import { SourceTitle } from "@/components/source-title";
import { Badge, Button } from "@/components/ui";
import { ago, type Interval, type SourceView } from "@/lib/sources";

/**
 * A browser-automation import in the "Automated imports" tab. Like a plugin row,
 * but its "Sync" is a headless Playwright replay (POST /api/automations/run) and it
 * surfaces the last-run status/error. Interval + Remove reuse the parent handlers so
 * editing an automation is identical to editing any other automated import.
 */
export function AutomationRow({
  source,
  saving,
  removing,
  onIntervalChange,
  onRemove,
  onRan,
}: {
  source: SourceView;
  saving: boolean;
  removing: boolean;
  onIntervalChange: (i: Interval) => void;
  onRemove?: () => void;
  onRan: () => void;
}) {
  const { id, name, interval, lastSync, automationStatus, automationError, detail } = source;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function runNow() {
    setRunning(true);
    setError("");
    const res = await fetch(`/api/automations/run?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    setRunning(false);
    if (!res.ok) setError(data.error || "Run failed.");
    onRan(); // refresh the list either way — last-run status updated
  }

  const failed = automationStatus === "error";

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-fg">
          <RefreshCw width={17} height={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceTitle id={id} name={name} hasData={Boolean(source.hasData)} />
            <Badge>automation</Badge>
            {failed ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                <AlertTriangle width={11} height={11} /> last run failed
              </span>
            ) : automationStatus === "ok" ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                <Check width={12} height={12} /> last run ok
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-fg">
            {failed ? (
              automationError || detail
            ) : (
              <span className="inline-flex items-center gap-1">
                <Clock width={11} height={11} /> {lastSync ? `ran ${ago(lastSync)}` : "not run yet"} · {detail}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {saving ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
          <IntervalSelect value={interval} onChange={onIntervalChange} disabled={saving} />
          <Button size="sm" variant="secondary" onClick={runNow} disabled={running} title="Replay this automation now">
            {running ? <Spinner width={14} height={14} /> : <Play width={14} height={14} />}
            {running ? "Running…" : "Run"}
          </Button>
          {onRemove ? (
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={removing} title="Remove this automation">
              {removing ? <Spinner width={14} height={14} /> : <Trash width={14} height={14} />}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p className="mt-2 pl-12 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
