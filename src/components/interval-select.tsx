"use client";

import { INTERVALS, type Interval } from "@/lib/sources";
import { cn } from "@/components/ui";

/**
 * Per-source sync-cadence dropdown, shared by the GitHub row and every generic
 * source row so the whole Pipeline-tab list reads the same. Compact (h-8) to sit
 * inline in a source row.
 */
export function IntervalSelect({
  value,
  onChange,
  disabled,
  title,
}: {
  value: Interval;
  onChange: (i: Interval) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      title={title ?? "Sync interval"}
      onChange={(e) => onChange(e.target.value as Interval)}
      className={cn(
        "h-8 rounded-lg border border-input bg-bg px-2 text-[13px] text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring/60",
        "disabled:opacity-50",
      )}
    >
      {INTERVALS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
