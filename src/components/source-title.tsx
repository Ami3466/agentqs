"use client";

import Link from "next/link";
import { sourceIcon } from "@/components/icons";
import { Badge, cn } from "@/components/ui";
import { ago, type SourceCoverage, type SourceProvenance } from "@/lib/sources";

/**
 * A Pipeline row's source name. Once the source has landed data the name links
 * to the Journal pre-filtered to it (/journal?source=<id>) — clicking an
 * integration answers "what data came from this?". No data yet → plain text.
 */
export function SourceTitle({
  id,
  name,
  hasData,
  title,
  className,
}: {
  /** Source id as it appears in the daily table's `source` column. */
  id: string;
  name: string;
  hasData: boolean;
  title?: string;
  /** Overrides the default text size (rows outside the standard list are smaller). */
  className?: string;
}) {
  const base = cn("truncate font-medium text-fg", className ?? "text-sm");
  if (!hasData) {
    return (
      <p className={base} title={title}>
        {name}
      </p>
    );
  }
  return (
    // prefetch off: dozens of rows would each prefetch the same client-filtered page
    <Link
      href={`/journal?source=${encodeURIComponent(id)}`}
      prefetch={false}
      className={cn(base, "block hover:text-accent hover:underline")}
      title={title ?? `See all ${name} data in the Journal`}
    >
      {name}
    </Link>
  );
}

/** "120 days · 2026-03-16 → 2026-07-13" — what this source actually landed.
 *  Counted from the record, so a connected-but-empty source says so out loud
 *  instead of rendering identically to a healthy one. */
export function coverageLine(coverage?: SourceCoverage): string {
  const { events = 0, days = 0, from = null, to = null } = coverage ?? {};
  if (!events && !days) return "no data yet";
  const parts: string[] = [];
  if (events) parts.push(`${events.toLocaleString()} events`);
  if (days) parts.push(`${days.toLocaleString()} days`);
  if (from && to) parts.push(from === to ? from : `${from} → ${to}`);
  return parts.join(" · ");
}

/**
 * The identity block of a connection row: mark, name, connected state, WHICH
 * account, and what actually landed — and, once there is data, the whole block is
 * the link to that data (/journal?source=<id>).
 *
 * This is the row's answer to the three questions the Pipeline tab kept dodging:
 * is it connected (a badge, not a 13px tick), which account is it (the login, so
 * two WHOOP athletes aren't twins), and did it sync (days + range + last run,
 * derived from the record). Actions stay OUTSIDE this block — nesting a button in
 * a link is neither valid nor clickable.
 */
export function SourceHeader({
  id,
  name,
  iconId,
  connected,
  hasData,
  provenance: provenanceProp,
  account,
  coverage,
  lastSync,
  title,
  badge,
}: {
  id: string;
  name: string;
  /** Draw a different source's mark (a product inside a provider card). */
  iconId?: string;
  connected: boolean;
  hasData: boolean;
  /** How this row got its data — decides the badge. Absent → derived from `connected`. */
  provenance?: SourceProvenance;
  /** The login this row is authorized as (WHOOP's email) — null when unknown. */
  account?: string | null;
  coverage?: SourceCoverage;
  lastSync?: string | null;
  title?: string;
  /** Extra state shown beside the name (stale). */
  badge?: React.ReactNode;
}) {
  const Icon = sourceIcon(iconId ?? id);
  // The bespoke rows (GitHub, WHOOP) drive their own status GET and pass no
  // provenance — a stored credential is the only way they are connected.
  const provenance: SourceProvenance | undefined = provenanceProp ?? (connected ? "credential" : undefined);
  // A source that is neither connected nor holding data has nothing to report —
  // the Connect button already says everything. Only a CONNECTED row owes the user
  // an answer to "did it actually sync?", and there "no data yet" is the answer.
  const meta = (
    connected || hasData
      ? [
          account || null,
          coverageLine(coverage),
          // "Synced" is a thing a CONNECTION does. A dropped file was imported once
          // and will never sync itself — saying "synced 2h ago" on it is the same
          // lie as the Connected badge, one line lower.
          lastSync ? `${provenance === "credential" ? "synced" : "imported"} ${ago(lastSync)}` : null,
        ]
      : []
  ).filter(Boolean) as string[];

  // ONE badge, and it says what this row actually is. "Connected" is reserved for a
  // stored credential: it means an account is authorized and this thing syncs by
  // itself. Everything else that merely HOLDS data says how it got here, so a CSV
  // you dropped can never masquerade as a live integration.
  const stateBadge =
    provenance === "credential" ? (
      <Badge tone="accent" title="An account is authorized and a working key is stored — this syncs on its schedule.">
        Connected
      </Badge>
    ) : provenance === "local-file" ? (
      <Badge title="Read from a file on this machine. No account, no key — re-run it from the CLI (the web server can't reach your disk).">
        Local file
      </Badge>
    ) : provenance === "automation" ? (
      <Badge tone="accent" title="A recorded browser recipe that replays on its schedule.">
        Automation
      </Badge>
    ) : hasData ? (
      <Badge title="Data you imported — a dropped file, an archive or an agent import. There is no account behind it and nothing syncs it.">
        Imported
      </Badge>
    ) : null;

  const inner = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
        <Icon width={18} height={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={cn("truncate text-sm font-medium text-fg", hasData && "group-hover:text-accent group-hover:underline")}>
            {name}
          </p>
          {stateBadge}
          {badge}
        </div>
        {meta.length ? (
          <p className="truncate text-xs text-muted-fg" title={meta.join(" · ")}>
            {meta.join(" · ")}
            {hasData ? <span className="ml-1 font-medium text-accent">View data →</span> : null}
          </p>
        ) : null}
      </div>
    </>
  );

  if (!hasData) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-3" title={title}>
        {inner}
      </div>
    );
  }
  return (
    // prefetch off: dozens of rows would each prefetch the same client-filtered page
    <Link
      href={`/journal?source=${encodeURIComponent(id)}`}
      prefetch={false}
      className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
      title={title ?? `See everything ${name} put in your record`}
    >
      {inner}
    </Link>
  );
}
