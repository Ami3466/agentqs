"use client";

import { useState } from "react";
import { Button, Card, cn } from "./ui";
import { Check, Sliders, Spinner } from "./icons";
import {
  SELF_DIMENSIONS,
  SELF_MAX,
  SELF_MIN,
} from "@/lib/self-log";

/** Local YYYY-MM-DD (no UTC drift), so "today" matches the timeline's day. */
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MID = Math.round((SELF_MIN + SELF_MAX) / 2);

/**
 * "How was today" — the daily self-rating capture. One 1–10 slider per clearly
 * labeled dimension (Mood · Energy · Focus · Sleep quality). Save writes to
 * record/daily/self.csv through /api/daily and calls `onSaved` so the numbers
 * appear on the timeline for the day as a `self` source. No invented words.
 */
export function DailyLog({ onSaved }: { onSaved?: () => void }) {
  const [date, setDate] = useState(todayIso);
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(SELF_DIMENSIONS.map((d) => [d.key, MID])),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: string, n: number) => {
    setValues((v) => ({ ...v, [key]: n }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/daily", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, ratings: values }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "Could not save your check-in.");
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sliders width={16} height={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-fg">How was today</h2>
          <span className="text-xs text-muted-fg">1–10</span>
        </div>
        <input
          type="date"
          value={date}
          max={todayIso()}
          onChange={(e) => {
            setDate(e.target.value || todayIso());
            setSaved(false);
          }}
          className="h-8 rounded-lg border border-input bg-bg px-2 text-[13px] text-muted-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {SELF_DIMENSIONS.map((dim) => (
          <div key={dim.key}>
            <div className="flex items-baseline justify-between">
              <label htmlFor={`self-${dim.key}`} className="text-sm font-medium text-fg">
                {dim.label}
              </label>
              <span className="font-mono text-sm font-semibold text-fg">
                {values[dim.key]}
              </span>
            </div>
            <input
              id={`self-${dim.key}`}
              type="range"
              min={SELF_MIN}
              max={SELF_MAX}
              step={1}
              value={values[dim.key]}
              onChange={(e) => set(dim.key, Number(e.target.value))}
              className="mt-1.5 h-1.5 w-full cursor-pointer accent-accent"
            />
            <p className="mt-1 text-[11px] text-muted-fg">{dim.hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {saving ? (
            <Spinner width={14} height={14} />
          ) : saved ? (
            <Check width={14} height={14} />
          ) : null}
          {saved ? "Saved" : "Save check-in"}
        </Button>
        {error ? (
          <span className={cn("text-[13px] text-destructive")}>{error}</span>
        ) : saved ? (
          <span className="text-[13px] text-muted-fg">Added to today on your timeline.</span>
        ) : null}
      </div>
    </Card>
  );
}
