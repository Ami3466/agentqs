"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Badge, Card, cn, Skeleton, SkeletonRows } from "./ui";
import { useCachedFetch } from "@/lib/client-cache";
import type { CoverageReport, SourceCoverage } from "@/lib/coverage";

/** Density buckets, faint → solid. Static classes so Tailwind keeps them. */
const BUCKETS = ["bg-muted/40", "bg-accent/20", "bg-accent/40", "bg-accent/60", "bg-accent/80", "bg-accent"];

/** Log-scaled bucket for a cell count against the record's busiest cell — so a daily
 *  source and a metric-heavy one both read, instead of one washing the other out. */
function bucketFor(count: number, max: number): string {
  if (!count) return BUCKETS[0];
  const scale = Math.log(count + 1) / Math.log(max + 1); // 0..1
  const idx = 1 + Math.min(4, Math.floor(scale * 4));
  return BUCKETS[idx];
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-lg font-semibold text-fg">{value}</div>
      <div className="truncate text-xs text-muted-fg">{label}</div>
    </div>
  );
}

/** A cell's target. From Pipeline that is a link into the Journal; from INSIDE the
 *  Journal a navigation would be a no-op the user reads as a broken click, so the
 *  host passes `onPick` and the cell drills into the table it is already on. */
function Open({
  source,
  onPick,
  className,
  title,
  children,
}: {
  source: string;
  onPick?: (source: string) => void;
  className: string;
  title: string;
  children?: React.ReactNode;
}) {
  if (onPick) {
    return (
      <button type="button" onClick={() => onPick(source)} title={title} className={cn("w-full text-left", className)}>
        {children}
      </button>
    );
  }
  return (
    <Link href={`/journal?source=${encodeURIComponent(source)}`} title={title} className={className}>
      {children}
    </Link>
  );
}

function Row({
  s,
  years,
  max,
  onPick,
}: {
  s: SourceCoverage;
  years: number[];
  max: number;
  onPick?: (source: string) => void;
}) {
  const where = onPick ? "Show it in the table." : "Open in Journal.";
  return (
    <tr className="group">
      <td className="sticky left-0 z-10 bg-bg pl-4 pr-3 group-hover:bg-muted/40">
        <Open
          source={s.source}
          onPick={onPick}
          className="flex items-center gap-2 py-1"
          title={`${s.source} — ${s.rows.toLocaleString()} rows, ${s.days.toLocaleString()} days (${s.first} → ${s.last}). ${where}`}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-fg hover:text-accent">{s.source}</span>
          <Badge className="shrink-0">{fmt(s.rows)}</Badge>
        </Open>
      </td>
      {years.map((y) => {
        const n = s.byYear[String(y)] ?? 0;
        return (
          <td key={y} className="px-0.5">
            <Open
              source={s.source}
              onPick={onPick}
              title={n ? `${s.source} · ${y} · ${n.toLocaleString()} rows` : `${s.source} · ${y} · no data`}
              className={cn(
                "block h-6 w-6 rounded-sm transition-transform hover:scale-125 hover:ring-1 hover:ring-accent",
                bucketFor(n, max),
              )}
            />
          </td>
        );
      })}
    </tr>
  );
}

/** Section title. On the Pipeline page the heatmap is one panel among several, so it
 *  says what it is — including while it loads, or the section is an anonymous block
 *  of grey bars. On the Journal tab it is the whole view, and the hint changes with
 *  where a click lands. */
function Header({ hint }: { hint: string }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4">
      <p className="shrink-0 text-sm font-medium text-fg">Coverage</p>
      <p className="min-w-0 flex-1 truncate text-xs text-muted-fg" title={`Every source by year, richest first. ${hint}`}>
        every source by year — {hint.toLowerCase()}
      </p>
    </div>
  );
}

/** Holds the heatmap's shape while it loads — four stat slots and a run of source
 *  rows — so the page lands once instead of jumping when the data arrives. */
function CoverageSkeleton({ hint }: { hint: string }) {
  return (
    <Card className="p-0">
      <Header hint={hint} />
      <div className="grid grid-cols-2 gap-4 px-4 pt-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <div className="p-4">
        <SkeletonRows rows={6} rowClassName="h-6" label="Loading your record" />
      </div>
    </Card>
  );
}

/** The whole record as a source×year heatmap, derived entirely from GET /api/coverage
 *  (survives reload), richest source first. Two hosts, one component:
 *
 *  • Pipeline — under the source list, because it grades it: which stream goes back
 *    how far, and where the holes are. Cells link into the Journal.
 *  • Journal — a third view beside Table and Timeline. The host passes `onSourceClick`
 *    so a cell drills into the table it is already on, and `emptyHint` because
 *    "connect a source" points somewhere else from there.
 */
export function CoverageGrid({
  onSourceClick,
  emptyHint = "No data yet. Connect a source above to fill this in.",
  tall = false,
}: {
  onSourceClick?: (source: string) => void;
  emptyHint?: string;
  /** The grid is the whole view (Journal) rather than one panel among several
   *  (Pipeline), so it may take more of the page before it starts scrolling. */
  tall?: boolean;
} = {}) {
  // Cached: coming back to a tab renders the last heatmap instantly and refreshes
  // behind it, instead of re-running the whole scan and showing a bare "Loading…"
  // every single visit. A capture on the same page invalidates the key, which
  // refetches in place (client-cache keeps it on screen).
  const { data, error, loading } = useCachedFetch<CoverageReport>("/api/coverage");
  const hint = onSourceClick ? "Click a cell to show that source in the table." : "Click a cell to open it in the Journal.";

  const max = useMemo(() => {
    if (!data) return 1;
    let m = 1;
    for (const s of data.sources) for (const y of data.years) m = Math.max(m, s.byYear[String(y)] ?? 0);
    return m;
  }, [data]);

  if (loading) return <CoverageSkeleton hint={hint} />;
  if (error && !data) return <Card className="p-4 text-sm text-destructive">{error}</Card>;
  if (!data) return <CoverageSkeleton hint={hint} />;
  if (data.sources.length === 0)
    return (
      <Card className="p-0">
        <Header hint={hint} />
        <p className="p-4 text-sm text-muted-fg">{emptyHint}</p>
      </Card>
    );

  const spanLabel =
    data.span.first && data.span.last ? `${data.span.first.slice(0, 4)}–${data.span.last.slice(0, 4)}` : "—";

  return (
    // One panel, like every other section on this page: title, the record's totals,
    // then the grid those totals summarize.
    <Card className="overflow-hidden p-0">
      <Header hint={hint} />
      <div className="px-4 pt-3">
        {/* A refresh that fails over data already on screen: keep the heatmap, say so. */}
        {error ? <p className="pb-2 text-xs text-destructive">Could not refresh: {error}</p> : null}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="sources" value={String(data.sources.length)} />
          <Stat label="rows" value={fmt(data.totalRows)} />
          <Stat label="days covered" value={fmt(data.totalDays)} />
          <Stat label="span" value={spanLabel} />
        </div>
      </div>

      <div className="pt-3">
        {/* No padding on the scrollport: the sticky source column and year header
            pin to its edges, and any inset would let rows show through the gap. */}
        <div className={cn("overflow-auto scrollbar-thin pb-3", tall ? "max-h-[70vh]" : "max-h-[50vh]")}>
          <table className="border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 bg-bg py-2 pl-4 pr-3 text-left text-xs font-medium text-muted-fg">
                  source
                </th>
                {data.years.map((y) => (
                  <th
                    key={y}
                    className="sticky top-0 z-10 bg-bg px-0.5 pb-2 text-center text-[10px] font-medium tabular-nums text-muted-fg"
                  >
                    {String(y).slice(2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <Row key={s.source} s={s} years={data.years} max={max} onPick={onSourceClick} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
