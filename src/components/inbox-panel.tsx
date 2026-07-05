"use client";

import { useEffect, useState } from "react";
import { Inbox } from "@/components/icons";

interface Item {
  id: string;
  ts: string;
  source: string;
  kind: string;
  text: string;
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Live pending bucket. Memos logged with `>>` in Chat land here (Loop 6);
 * the Structure button that drains it arrives in Loop 7. */
export function InboxPanel() {
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/inbox");
      if (!res.ok || !live) return;
      const data = (await res.json()) as { pending: number; items: Item[] };
      setPending(data.pending);
      setItems(data.items);
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Inbox width={16} height={16} className="text-muted-fg" />
        <p className="text-sm font-semibold text-fg">Pending inbox</p>
        {pending != null ? (
          <span className="ml-auto inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
            {pending}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-fg">
        Everything lands here raw and free. Hit <b>Structure</b> to turn it into clean daily data —
        you only spend tokens on the button.
      </p>

      {items.length ? (
        <ul className="mt-3 space-y-1.5">
          {items.map((it) => (
            <li key={it.id} className="rounded-lg border border-border bg-bg px-3 py-2">
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-fg">
                <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{it.source}</span>
                <span>{ago(it.ts)}</span>
              </div>
              <p className="line-clamp-2 text-sm text-fg">{it.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-fg">
          Empty. Log a memo with <code className="font-mono">&gt;&gt;</code> in Chat, or drop a CSV,
          export, or screenshot here.
        </div>
      )}
    </div>
  );
}
