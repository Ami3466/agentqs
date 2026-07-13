"use client";

import { useEffect, useState } from "react";
import { sourceIcon, Spinner, Trash } from "@/components/icons";
import { Sparkline } from "@/components/sparkline";
import { SourceTitle } from "@/components/source-title";
import { Badge, Button } from "@/components/ui";
import type { SourceJobView } from "@/lib/sources";

/**
 * WHOOP (per-minute, unofficial) — RETIRED UPSTREAM, so this row is a headstone,
 * not a connect form.
 *
 * WHOOP deleted the app-login endpoint this source rode on (api-7.whoop.com no
 * longer resolves). Every login attempt therefore dies in DNS, and the failure
 * surfaced as "wrong password" — the app blaming the user for something WHOOP
 * removed. A door that cannot open must not be shown as a door: no email, no
 * password, no Sync. What stays is what still has value — the per-minute history
 * already in the record (sparkline + counts) and the way out (Remove) — plus the
 * connect that does work: the official WHOOP API row (OAuth).
 */

interface Point {
  date: string;
  value: number;
}
interface Status {
  connected: boolean;
  hasData: boolean;
  days: number;
  latest: number | null;
  minutes: number;
  series: Point[];
}

export function WhoopConnect({
  version = 0,
  removing = false,
  onRemove,
}: {
  version?: number;
  interval?: string;
  due?: boolean;
  savingInterval?: boolean;
  removing?: boolean;
  job?: SourceJobView | null;
  onIntervalChange?: (i: never) => void;
  onRemove?: () => void;
  onSyncStarted?: () => void;
} = {}) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/import/whoop");
      if (res.ok) setStatus((await res.json()) as Status);
    })();
  }, [version]);

  const Icon = sourceIcon("whoop");
  const hasData = Boolean(status?.hasData);

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg opacity-60">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SourceTitle
              id="whoop"
              name="WHOOP (per-minute, unofficial)"
              hasData={hasData}
              title="WHOOP deleted the app-login endpoint this source used — connect the official WHOOP API row instead"
            />
            <Badge title="WHOOP removed the unofficial app-login endpoint (api-7.whoop.com). Nothing to log in to — your password is fine.">
              retired upstream
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-fg" title="Per-minute heart rate has no server-reachable API any more. Recovery, strain and sleep come from the official WHOOP API row (Authorize).">
            {hasData
              ? `${status?.minutes.toLocaleString() ?? 0} minutes kept in your record. Use WHOOP (official API) to keep syncing.`
              : "Use the WHOOP (official API) row — recovery, strain & sleep via Authorize."}
          </p>
        </div>
        {onRemove ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            disabled={removing}
            className="shrink-0"
            title="Remove this row — the per-minute heart-rate data already in your record stays"
          >
            {removing ? <Spinner width={14} height={14} /> : <Trash width={14} height={14} />}
            Remove
          </Button>
        ) : null}
      </div>

      {status?.series.length ? (
        <div className="mt-3 pl-12 opacity-70">
          <Sparkline
            points={status.series}
            variant="bar"
            ariaLabel={`${status.series.length}-day recovery history`}
            title={(p) => `${p.date}: ${p.value}% recovery`}
          />
        </div>
      ) : null}
    </div>
  );
}
