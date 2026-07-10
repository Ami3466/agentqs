"use client";

import type { Point } from "@/lib/grounding";
import { cn } from "./ui";

/**
 * A dependency-free sparkline drawn on the `--accent` token — reused everywhere a
 * number needs its shape over time (the Pipeline-tab commit history, a grounded chat
 * reply). Two forms:
 *   - `bar`  — one bar per day, faded on zero days (commits/day style).
 *   - `line` — a smooth trend with a filled area + a dot on the latest point.
 * Points are ascending by date. Each mark carries a native `<title>` tooltip.
 */

const fmtDefault = (v: number) => `${Math.round(v * 100) / 100}`;

export function Sparkline({
  points,
  variant = "bar",
  height = variant === "line" ? 34 : 28,
  barWidth = 4,
  gap = 2,
  step = 8,
  className,
  format = fmtDefault,
  title,
  ariaLabel,
}: {
  points: Point[];
  variant?: "bar" | "line";
  height?: number;
  barWidth?: number;
  gap?: number;
  step?: number;
  className?: string;
  format?: (v: number) => string;
  title?: (p: Point) => string;
  ariaLabel?: string;
}) {
  if (!points.length) return null;
  const tip = title ?? ((p: Point) => `${p.date}: ${format(p.value)}`);
  const label = ariaLabel ?? `${points.length}-point trend`;

  if (variant === "line") {
    const pad = 3;
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const w = Math.max(1, points.length - 1) * step + pad * 2;
    const x = (i: number) => pad + i * step;
    const y = (v: number) => pad + (1 - (v - min) / range) * (height - pad * 2);
    const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
    const area = `${x(0)},${height} ${line} ${x(points.length - 1)},${height}`;
    const last = points[points.length - 1];
    return (
      <div className={cn("scrollbar-thin overflow-x-auto", className)}>
        <svg width={w} height={height} className="text-accent" role="img" aria-label={label}>
          <polygon points={area} fill="currentColor" opacity={0.12} />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {points.map((p, i) => (
            <circle key={p.date} cx={x(i)} cy={y(p.value)} r={step / 2} fill="transparent">
              <title>{tip(p)}</title>
            </circle>
          ))}
          <circle cx={x(points.length - 1)} cy={y(last.value)} r={2.5} fill="currentColor" />
        </svg>
      </div>
    );
  }

  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className={cn("scrollbar-thin overflow-x-auto", className)}>
      <svg
        width={points.length * (barWidth + gap)}
        height={height}
        className="text-accent"
        role="img"
        aria-label={label}
      >
        {points.map((p, i) => {
          const bh = Math.max(1, Math.round((p.value / max) * height));
          return (
            <rect
              key={p.date}
              x={i * (barWidth + gap)}
              y={height - bh}
              width={barWidth}
              height={bh}
              rx={1}
              fill="currentColor"
              opacity={p.value ? 0.9 : 0.25}
            >
              <title>{tip(p)}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
