"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Chart, Chat, Data, Journal, Settings } from "./icons";
import { cn } from "./ui";

const TABS = [
  { href: "/", label: "Chat", Icon: Chat, match: (p: string) => p === "/" },
  { href: "/graphs", label: "Graphs", Icon: Chart, match: (p: string) => p.startsWith("/graphs") },
  { href: "/journal", label: "Journal", Icon: Journal, match: (p: string) => p.startsWith("/journal") },
  { href: "/pipeline", label: "Pipeline", Icon: Data, match: (p: string) => p.startsWith("/pipeline") },
  { href: "/settings", label: "Settings", Icon: Settings, match: (p: string) => p.startsWith("/settings") },
];

export function TabNav() {
  const pathname = usePathname();
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
