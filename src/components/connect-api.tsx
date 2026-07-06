"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, Terminal } from "./icons";
import { cn } from "./ui";
import { CopyBlock } from "./copy-block";

/**
 * The Supabase-style Connect / API affordance (Loop 15). Context-aware: on each tab
 * it shows the equivalent CLI command + the real HTTP API call for what you're
 * viewing, plus a one-click "Connect to Claude Code" (MCP) config. One brain, three
 * faces — the UI just surfaces the CLI/API face of whatever screen you're on. The
 * API host tracks wherever the app is actually served.
 */

interface Snip {
  title: string;
  cli: string;
  api: (base: string) => string;
  extra?: { label: string; code: (base: string) => string };
}

/** The Settings snippet quotes the user's actual saved model (never a hardcoded
 *  id); MODEL_ID is a self-evident placeholder until a provider is connected. */
function snippetsFor(model: string): Record<string, Snip> {
  const m = model || "MODEL_ID";
  return {
    chat: {
      title: "Chat",
      cli: `agentqs chat "why have I felt off this week?"`,
      api: (b) => `curl -N ${b}/api/chat \\
  -H 'content-type: application/json' \\
  -d '{"message":"why have I felt off this week?"}'`,
    },
    journal: {
      title: "Journal",
      cli: `agentqs journal --table`,
      api: (b) => `curl ${b}/api/journal`,
      extra: {
        label: "Semantic search — find days that felt like this",
        code: (b) => `curl ${b}/api/search \\
  -H 'content-type: application/json' \\
  -d '{"query":"anxious, could not sleep"}'`,
      },
    },
    data: {
      title: "Data",
      cli: `agentqs sync --source github`,
      api: (b) => `curl -X POST ${b}/api/import/github \\
  -H 'content-type: application/json' \\
  -d '{"login":"torvalds"}'`,
    },
    settings: {
      title: "Settings",
      cli: `agentqs config set model ${m}`,
      api: (b) => `curl -X POST ${b}/api/settings \\
  -H 'content-type: application/json' \\
  -d '{"model":"${m}"}'`,
    },
  };
}

const MCP_JSON = `{
  "mcpServers": {
    "agentqs": {
      "command": "agentqs",
      "args": ["serve", "--mcp"]
    }
  }
}`;

const MCP_ADD = `claude mcp add-json agentqs '{"command":"agentqs","args":["serve","--mcp"]}'`;

function tabKey(pathname: string): "chat" | "journal" | "data" | "settings" {
  if (pathname.startsWith("/journal")) return "journal";
  if (pathname.startsWith("/data")) return "data";
  if (pathname.startsWith("/settings")) return "settings";
  return "chat";
}

export function ConnectApi({ model = "" }: { model?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState("http://localhost:3000");
  const ref = useRef<HTMLDivElement>(null);
  const snip = snippetsFor(model)[tabKey(pathname)];

  useEffect(() => {
    if (typeof window !== "undefined") setBase(window.location.origin);
  }, []);

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
        <span className="hidden sm:inline">Connect / API</span>
        <ChevronDown
          width={14}
          height={14}
          className={cn("transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="scrollbar-thin absolute right-0 z-50 mt-2 max-h-[calc(100vh-5rem)] w-[380px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-xl">
          <p className="mb-3 text-sm font-semibold text-fg">
            {snip.title} · from the terminal
          </p>
          <div className="space-y-3">
            <CopyBlock label="Install the CLI (once)" code="npm link" />
            <CopyBlock label="CLI" code={snip.cli} />
            <CopyBlock label="API" code={snip.api(base)} />
            {snip.extra ? (
              <CopyBlock label={snip.extra.label} code={snip.extra.code(base)} />
            ) : null}
            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-[11px] text-muted-fg">
                Drive your whole record from Claude Code — add the MCP server once:
              </p>
              <CopyBlock label="Connect to Claude Code (MCP)" code={MCP_ADD} />
              <CopyBlock label="…or paste into .mcp.json" code={MCP_JSON} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
