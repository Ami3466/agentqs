"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { warmCache, whenIdle } from "@/lib/client-cache";
import { Chart, Chat, Data, Journal, Settings } from "./icons";
import { cn } from "./ui";

// Coverage has no tab of its own: the source×year heatmap lives inside Pipeline,
// under the source list it grades. /overview redirects there.
const TABS = [
  { href: "/", label: "Chat", Icon: Chat, match: (p: string) => p === "/" },
  { href: "/graphs", label: "Graphs", Icon: Chart, match: (p: string) => p.startsWith("/graphs") },
  { href: "/journal", label: "Journal", Icon: Journal, match: (p: string) => p.startsWith("/journal") },
  { href: "/pipeline", label: "Pipeline", Icon: Data, match: (p: string) => p.startsWith("/pipeline") || p.startsWith("/overview") },
  { href: "/settings", label: "Settings", Icon: Settings, match: (p: string) => p.startsWith("/settings") },
];

/**
 * The two cheap views only, warmed ONCE per page load. These ARE the cache keys
 * the panels read (they key on their own url), so a warmed entry is picked up
 * as-is — the panel renders from it and never shows a loading state.
 *
 * `/api/sources`, `/api/log` and `/api/journal?days=180` used to be warmed here
 * too, but prod is a single Node process with a SYNCHRONOUS better-sqlite3, and
 * those cost 1.6-2.4s and up to 2.5MB each — every one of them was a warm-up
 * blocking the click it was meant to speed up. And they were paying that cost
 * on EVERY navigation, not once: prod writes constantly (Slack capture, syncs,
 * the extension), so the 60s cache-fingerprint memo they leaned on was busted
 * far more often than it hit. Those tabs now just fetch on first visit, same as
 * before this warmer existed — slower the first time, never in the way.
 */
const WARM_URLS = ["/api/coverage", "/api/graphs/series?catalog=1"];

let warmed = false;

export function TabNav() {
  const pathname = usePathname();

  // Warm once per page load, not once per navigation — a module-level guard so a
  // tab change never re-triggers it (the module dies with the tab, which is the
  // right lifetime). Runs once the browser is idle so it never competes with the
  // render the user is waiting on.
  useEffect(() => {
    if (warmed) return;
    warmed = true;
    let stop: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      stop = warmCache(WARM_URLS);
    });
    return () => {
      cancelIdle();
      stop?.();
    };
  }, []);

  return (
    <nav className="flex w-full items-center gap-1 sm:w-auto">
      {TABS.map(({ href, label, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            id={`tour-tab-${label.toLowerCase()}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] font-medium transition-colors",
              "sm:flex-none sm:flex-row sm:gap-2 sm:px-3 sm:py-2 sm:text-sm",
              active
                ? "bg-muted text-fg"
                : "text-muted-fg hover:bg-muted/60 hover:text-fg",
            )}
          >
            <Icon width={16} height={16} />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
