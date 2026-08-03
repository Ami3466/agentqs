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
 * What each tab needs, in the order a warm-up should fetch it. These ARE the cache
 * keys the panels read (they key on their own url), so a warmed entry is picked up
 * as-is — the panel renders from it and never shows a loading state.
 *
 * Cheapest first: the small views land while the megabyte-scale journal payloads
 * are still on the wire, so the tabs a user is most likely to click next are ready
 * first. The list is deliberately not exhaustive — this warms the ONE payload that
 * dominates each tab, not every panel on it.
 */
const WARM_URLS = [
  "/api/coverage",
  "/api/sources",
  "/api/log",
  "/api/graphs/series",
  "/api/journal?days=180",
];

export function TabNav() {
  const pathname = usePathname();

  // Warm the other tabs once this one is drawn and the browser is idle. Sequential
  // and skip-if-fresh/in-flight (see warmCache), so the current tab's own requests
  // are never crowded out — whatever it is already fetching is simply skipped here.
  // Re-runs per navigation: fresh entries are a no-op, and anything a write
  // invalidated gets refilled before the user walks over to it.
  useEffect(() => {
    let stop: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      stop = warmCache(WARM_URLS);
    });
    return () => {
      cancelIdle();
      stop?.();
    };
  }, [pathname]);

  return (
    <nav className="flex items-center gap-1">
      {TABS.map(({ href, label, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            id={`tour-tab-${label.toLowerCase()}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-muted text-fg"
                : "text-muted-fg hover:bg-muted/60 hover:text-fg",
            )}
          >
            <Icon width={16} height={16} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
