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

function Row({ s, years, max }: { s: SourceCoverage; years: number[]; max: number }) {
  return (
    <tr className="group">
      <td className="sticky left-0 z-10 bg-bg pr-3 group-hover:bg-muted/40">
        <Link
          href={`/journal?source=${encodeURIComponent(s.source)}`}
          className="flex items-center gap-2 py-1"
          title={`${s.source} — ${s.rows.toLocaleString()} rows, ${s.days.toLocaleString()} days (${s.first} → ${s.last}). Open in Journal.`}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-fg hover:text-accent">{s.source}</span>
          <Badge className="shrink-0">{fmt(s.rows)}</Badge>
        </Link>
      </td>
      {years.map((y) => {
        const n = s.byYear[String(y)] ?? 0;
        return (
          <td key={y} className="px-0.5">
            <Link
              href={`/journal?source=${encodeURIComponent(s.source)}`}
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

/** Holds the heatmap's shape while it loads — four stat slots and a run of source
 *  rows — so the page lands once instead of jumping when the data arrives. */
function CoverageSkeleton() {
  return (
    <div className="space-y-4">
      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </Card>
      <Card className="p-4">
        <SkeletonRows rows={8} rowClassName="h-6" label="Loading your record" />
      </Card>
    </div>
  );
}

/** The Overview tab: the whole record as a source×year heatmap. Derived entirely from
 *  GET /api/coverage (survives reload), richest source first. A cell → the Journal
 *  filtered to that source, so "see all my data" is one glance and one click. */
export function CoverageGrid() {
  // Cached: coming back to Overview from another tab renders the last heatmap
  // instantly and refreshes behind it, instead of re-running the whole scan and
  // showing a bare "Loading…" every single visit.
  const { data, error, loading } = useCachedFetch<CoverageReport>("/api/coverage");

  const max = useMemo(() => {
    if (!data) return 1;
    let m = 1;
    for (const s of data.sources) for (const y of data.years) m = Math.max(m, s.byYear[String(y)] ?? 0);
    return m;
  }, [data]);

  if (loading) return <CoverageSkeleton />;
  if (error && !data) return <Card className="p-4 text-sm text-destructive">{error}</Card>;
  if (!data) return <CoverageSkeleton />;
  if (data.sources.length === 0)
    return <Card className="text-sm text-muted-fg">No data yet. Connect a source in Pipeline to fill this in.</Card>;

  const spanLabel =
    data.span.first && data.span.last ? `${data.span.first.slice(0, 4)}–${data.span.last.slice(0, 4)}` : "—";

  return (
    <div className="space-y-4">
      {/* A refresh that fails over data already on screen: keep the heatmap, say so. */}
      {error ? <p className="text-xs text-destructive">Could not refresh: {error}</p> : null}
      <Card className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="sources" value={String(data.sources.length)} />
        <Stat label="rows" value={fmt(data.totalRows)} />
        <Stat label="days covered" value={fmt(data.totalDays)} />
        <Stat label="span" value={spanLabel} />
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="max-h-[70vh] overflow-auto scrollbar-thin">
          <table className="border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 bg-bg py-2 pr-3 text-left text-xs font-medium text-muted-fg">
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
                <Row key={s.source} s={s} years={data.years} max={max} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
