"use client";

import { useMemo } from "react";
import { Card } from "./ui";
import { MessageSquare, Sparkles } from "./icons";
import { cn } from "./ui";
import type { JournalData, JournalDay, MetricColumn } from "@/lib/journal";

/** Parse a YYYY-MM-DD as a *local* date (no TZ drift) for display. */
function localDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function relativeLabel(iso: string): string | null {
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = Math.round((t0 - localDate(iso).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return `${diff}d ago`;
  return null;
}

const SKILL_TINT: Record<string, string> = {
  mentor: "text-accent",
  therapist: "text-accent",
  coach: "text-accent",
};

function DayCard({
  day,
  metricsByKey,
}: {
  day: JournalDay;
  metricsByKey: Map<string, MetricColumn>;
}) {
  const dt = localDate(day.date);
  const rel = relativeLabel(day.date);

  // Group metric cells by source for readable chip rows.
  const bySource = new Map<string, Array<{ metric: string; value: string; numeric: boolean }>>();
  for (const [key, cell] of Object.entries(day.values)) {
    const col = metricsByKey.get(key);
    const source = col?.source ?? key.split(".")[0];
    const metric = col?.metric ?? key.split(".").slice(1).join(".");
    const list = bySource.get(source) ?? [];
    list.push({
      metric,
      value: cell.num != null ? String(cell.num) : cell.text,
      numeric: !!col?.numeric,
    });
    bySource.set(source, list);
  }

  return (
    <Card className="flex gap-4 p-4">
      <div className="w-20 shrink-0 text-center">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-fg">
          {WD[dt.getDay()]}
        </div>
        <div className="text-2xl font-semibold leading-tight text-fg">{dt.getDate()}</div>
        <div className="text-[11px] text-muted-fg">
          {MO[dt.getMonth()]} {dt.getFullYear()}
        </div>
        {rel ? (
          <div className="mt-1 inline-flex rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
            {rel}
          </div>
        ) : null}
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        {bySource.size ? (
          <div className="space-y-1.5">
            {[...bySource.entries()].map(([source, cells]) => (
              <div key={source} className="flex flex-wrap items-center gap-1.5">
                <span className="shrink-0 text-[11px] font-medium text-muted-fg">{source}</span>
                {cells.map((c) => (
                  <span
                    key={c.metric}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-[11px]"
                  >
                    <span className="text-muted-fg">{c.metric}</span>
                    <span className={cn("font-medium text-fg", c.numeric && "font-mono")}>
                      {c.value}
                    </span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        {day.sessions.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5"
          >
            <Sparkles
              width={13}
              height={13}
              className={cn("shrink-0", SKILL_TINT[s.skill] ?? "text-accent")}
            />
            <span className="shrink-0 text-[13px] font-medium text-fg">{s.title ?? "Session"}</span>
            <span className="shrink-0 rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
              {s.skill}
            </span>
            {s.summary ? (
              <span
                className="min-w-0 flex-1 truncate text-[13px] text-muted-fg"
                title={s.summary}
              >
                {s.summary}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {s.commitments.length ? (
              <span className="shrink-0 text-[11px] text-muted-fg/70">
                {s.commitments.length}✓
              </span>
            ) : null}
          </div>
        ))}

        {day.memos.map((m) => (
          <div key={m.id} className="flex items-start gap-2 text-sm">
            <MessageSquare width={14} height={14} className="mt-0.5 shrink-0 text-muted-fg" />
            <p className="min-w-0 flex-1 text-muted-fg">
              <span className="text-fg">{m.text}</span>
              <span className="ml-1.5 text-[11px] text-muted-fg/70">· {m.source}</span>
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function JournalTimeline({ data }: { data: JournalData }) {
  const metricsByKey = useMemo(
    () => new Map(data.metrics.map((m) => [m.key, m])),
    [data.metrics],
  );

  if (!data.days.length) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-16 text-center">
        <p className="text-sm font-medium text-fg">No entries yet.</p>
        <p className="mt-1 text-sm text-muted-fg">
          Connect a source in Data, or log a memo in Chat.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.days.map((day) => (
        <DayCard key={day.date} day={day} metricsByKey={metricsByKey} />
      ))}
    </div>
  );
}
