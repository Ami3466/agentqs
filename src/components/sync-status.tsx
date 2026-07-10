"use client";

import { useEffect, useRef, useState } from "react";
import { ProgressBar } from "@/components/ui";
import { jobActive, type SourceJobView } from "@/lib/sources";

/**
 * The one sync-state line under a connection row, driven entirely by SERVER
 * state (the background job + run ledger) so it survives page refreshes:
 *   queued/running → live progress bar with the job's phase and percent
 *   just finished  → brief summary line (then fades)
 *   failed         → persistent error line until the next successful sync
 * `onFinished` fires exactly once when a job the user watched completes —
 * parents refresh their status/sparkline there.
 */
export function SyncStatus({
  job,
  lastRunError,
  className,
  onFinished,
}: {
  job: SourceJobView | null | undefined;
  lastRunError?: string | null;
  className?: string;
  onFinished?: (job: SourceJobView) => void;
}) {
  const active = jobActive(job);
  const [recentOk, setRecentOk] = useState(false);
  // Announce completion only for a job we actually saw running — a job that
  // finished last week must not flash "Synced" on every mount.
  const armed = useRef(false);
  const finished = !active && job?.finishedAt ? `${job.finishedAt}:${job.status}` : null;
  useEffect(() => {
    if (active) {
      armed.current = true;
      return;
    }
    if (!armed.current || !finished || !job) return;
    armed.current = false;
    onFinished?.(job);
    if (job.status === "ok") {
      setRecentOk(true);
      const t = window.setTimeout(() => setRecentOk(false), 6000);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, finished]);

  if (active && job) {
    const label =
      job.status === "queued" ? "Queued — waiting for another sync to finish…" : `${job.phase}…`;
    return <ProgressBar pct={job.pct} label={label} className={className} />;
  }
  if (recentOk && job?.status === "ok") {
    return (
      <p className={`text-xs text-accent ${className ?? ""}`}>
        Synced {job.days ?? 0} day{job.days === 1 ? "" : "s"}
        {job.dailyRows != null ? ` → ${job.dailyRows.toLocaleString()} daily rows` : ""}.
      </p>
    );
  }
  const error = job?.status === "error" ? job.error : lastRunError;
  if (error) {
    return (
      <p className={`truncate text-xs text-destructive ${className ?? ""}`} title={error}>
        Last sync failed: {error}
      </p>
    );
  }
  return null;
}
