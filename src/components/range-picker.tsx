"use client";

import { Input, Segmented } from "./ui";
import type { GraphRangePreset } from "@/lib/graphs";

/** The one time-range control: segmented 30/60/90/All presets plus a Custom
 * mode that reveals two date inputs. Journal and Graphs both render this, so
 * range picking looks and works the same everywhere. */

const OPTIONS: ReadonlyArray<{ value: GraphRangePreset; label: string }> = [
  { value: "30", label: "30d" },
  { value: "60", label: "60d" },
  { value: "90", label: "90d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

/** Resolve a preset to an inclusive from-date ("" = unbounded), anchored to today. */
export function rangeStart(range: GraphRangePreset, custom: string): string {
  if (range === "custom") return custom;
  if (range === "all") return "";
  const d = new Date();
  d.setDate(d.getDate() - (Number(range) - 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function RangePicker({
  value,
  onChange,
  startDate,
  endDate,
  onStartDate,
  onEndDate,
}: {
  value: GraphRangePreset;
  onChange: (v: GraphRangePreset) => void;
  startDate: string;
  endDate: string;
  onStartDate: (v: string) => void;
  onEndDate: (v: string) => void;
}) {
  return (
    <>
      <Segmented
        size="sm"
        options={OPTIONS}
        value={value}
        onChange={onChange}
        aria-label="Time range"
      />
      {value === "custom" ? (
        <>
          <Input
            type="date"
            value={startDate}
            max={endDate || undefined}
            onChange={(e) => onStartDate(e.target.value)}
            aria-label="Start date"
            className="h-8 w-full text-[13px] sm:w-[142px]"
          />
          <span className="text-[13px] text-muted-fg">to</span>
          <Input
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => onEndDate(e.target.value)}
            aria-label="End date"
            className="h-8 w-full text-[13px] sm:w-[142px]"
          />
        </>
      ) : null}
    </>
  );
}
