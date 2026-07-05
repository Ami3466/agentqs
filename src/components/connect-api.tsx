"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, Copy, Terminal } from "./icons";
import { cn } from "./ui";

/** Per-tab CLI + API + MCP snippets. Stub content for Loop 1. */
const SNIPPETS: Record<
  string,
  { title: string; cli: string; api: string }
> = {
  chat: {
    title: "Chat",
    cli: `agentqs chat "why have I felt off this week?"`,
    api: `curl -N localhost:3000/api/chat \\
  -d '{"message":"why have I felt off this week?"}'`,
  },
  journal: {
    title: "Journal",
    cli: `agentqs journal --since 7d --view timeline`,
    api: `curl localhost:3000/api/journal?since=7d`,
  },
  data: {
    title: "Data",
    cli: `agentqs sync --source github`,
    api: `curl -X POST localhost:3000/api/sources/github/sync`,
  },
  settings: {
    title: "Settings",
    cli: `agentqs config set model claude-sonnet-4-5`,
    api: `curl -X POST localhost:3000/api/settings \\
  -d '{"model":"claude-sonnet-4-5"}'`,
  },
};

const MCP = `{
  "mcpServers": {
    "agentqs": {
      "command": "agentqs",
      "args": ["serve", "--mcp"]
    }
  }
}`;

function tabKey(pathname: string): keyof typeof SNIPPETS {
  if (pathname.startsWith("/journal")) return "journal";
  if (pathname.startsWith("/data")) return "data";
  if (pathname.startsWith("/settings")) return "settings";
  return "chat";
}

function CopyBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex items-center gap-1 text-[11px] text-muted-fg transition-colors hover:text-fg"
        >
          {copied ? <Check width={12} height={12} /> : <Copy width={12} height={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg">
        {code}
      </pre>
    </div>
  );
}

export function ConnectApi() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const snip = SNIPPETS[tabKey(pathname)];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium transition-colors",
          open ? "bg-muted text-fg" : "bg-card text-muted-fg hover:bg-muted hover:text-fg",
        )}
      >
        <Terminal width={15} height={15} />
        Connect / API
        <ChevronDown
          width={14}
          height={14}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-fg">
              {snip.title} · from the terminal
            </p>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-fg">
              stub
            </span>
          </div>
          <div className="space-y-3">
            <CopyBlock label="CLI" code={snip.cli} />
            <CopyBlock label="API" code={snip.api} />
            <div className="border-t border-border pt-3">
              <CopyBlock label="Connect to Claude Code (MCP)" code={MCP} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
