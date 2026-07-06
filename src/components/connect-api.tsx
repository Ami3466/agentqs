"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, Copy, Lock, Spinner, Terminal } from "./icons";
import { cn } from "./ui";

/**
 * The Supabase-style Connect / API affordance. Context-aware: on each tab it
 * shows the equivalent CLI command + the real HTTP API call for what you're
 * viewing. It also mints the instance API key and fills it straight into copy-
 * paste snippets — curl, CLI, a Claude Code skill, and the MCP config — so a
 * headless agent can drive the whole record. One brain, three faces.
 */

interface Snip {
  title: string;
  cli: string;
  api: (base: string) => string;
}

const SNIPPETS: Record<string, Snip> = {
  chat: {
    title: "Chat",
    cli: `agentqs chat "why have I felt off this week?"`,
    api: (b) => `curl -N ${b}/api/chat \\
  -H "authorization: Bearer $AGENTQS_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"message":"why have I felt off this week?"}'`,
  },
  journal: {
    title: "Journal",
    cli: `agentqs journal --table`,
    api: (b) => `curl ${b}/api/journal -H "authorization: Bearer $AGENTQS_KEY"`,
  },
  data: {
    title: "Data",
    cli: `agentqs sync --source github`,
    api: (b) => `curl -X POST ${b}/api/import/github \\
  -H "authorization: Bearer $AGENTQS_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"login":"torvalds"}'`,
  },
  settings: {
    title: "Settings",
    cli: `agentqs config set model claude-sonnet-4-5`,
    api: (b) => `curl -X POST ${b}/api/settings \\
  -H "authorization: Bearer $AGENTQS_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"model":"claude-sonnet-4-5"}'`,
  },
};

function tabKey(pathname: string): keyof typeof SNIPPETS {
  if (pathname.startsWith("/journal")) return "journal";
  if (pathname.startsWith("/data")) return "data";
  if (pathname.startsWith("/settings")) return "settings";
  return "chat";
}

const KEY_PLACEHOLDER = "AQS_KEY_HERE";

function skillDoc(base: string, key: string): string {
  return `---
name: agentqs
description: Query and journal to the user's agentqs life-record — sleep, workouts, calendar, commits, memos. Use when they ask about their own data or want to talk to their mentor.
---

Call the agentqs API at ${base} with header \`authorization: Bearer ${key}\`.

- Ask the mentor:  POST /api/chat     {"message":"…"}
- Read the record: GET  /api/journal
- Log a memo:      POST /api/inbox    {"text":"…","source":"memo"}`;
}

function mcpJson(base: string, key: string): string {
  return `claude mcp add-json agentqs '{"command":"agentqs","args":["serve","--mcp"],"env":{"AGENTQS_URL":"${base}","AGENTQS_KEY":"${key}"}}'`;
}

function cliBlock(base: string, key: string): string {
  return `export AGENTQS_URL=${base}
export AGENTQS_KEY=${key}
agentqs chat "why have I felt off this week?"`;
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
  const [base, setBase] = useState("http://localhost:3000");
  const [hasKey, setHasKey] = useState(false);
  const [masked, setMasked] = useState("");
  const [fullKey, setFullKey] = useState(""); // shown once, right after generating
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const snip = SNIPPETS[tabKey(pathname)];

  // The key to weave into snippets: the real one this session, else a placeholder.
  const key = fullKey || (hasKey ? masked : KEY_PLACEHOLDER);

  useEffect(() => {
    if (typeof window !== "undefined") setBase(window.location.origin);
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setHasKey(Boolean(d.hasKey));
          setMasked(d.masked || "");
        }
      })
      .catch(() => {});
  }, [open]);

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

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch("/api/keys", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.key) {
        setFullKey(d.key);
        setMasked(d.masked || "");
        setHasKey(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        id="tour-connect"
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
        <div className="scrollbar-thin absolute right-0 z-50 mt-2 max-h-[calc(100vh-5rem)] w-[400px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-xl">
          {/* API key */}
          <div className="mb-4 rounded-lg border border-border bg-muted/50 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Lock width={13} height={13} className="text-muted-fg" />
              <span className="text-sm font-semibold text-fg">API key</span>
            </div>
            {fullKey ? (
              <>
                <CopyBlock label="Your new key — copy it now, it won't be shown again" code={fullKey} />
                <p className="mt-1.5 text-[11px] text-muted-fg">Filled into every snippet below.</p>
              </>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-muted-fg">
                  {hasKey ? masked : "No key yet"}
                </span>
                <button
                  type="button"
                  onClick={() => void generate()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? <Spinner width={13} height={13} /> : null}
                  {hasKey ? "Regenerate" : "Generate API key"}
                </button>
              </div>
            )}
          </div>

          {/* Contextual CLI + API for the current tab */}
          <p className="mb-2 text-sm font-semibold text-fg">{snip.title} · from the terminal</p>
          <div className="space-y-3">
            <CopyBlock label="CLI" code={snip.cli} />
            <CopyBlock label="API" code={snip.api(base)} />
          </div>

          {/* Programmatic access with the real key filled in */}
          <div className="mt-4 space-y-3 border-t border-border pt-3">
            <p className="text-[11px] text-muted-fg">
              Drive your whole record from a headless agent — key filled in:
            </p>
            <CopyBlock label="CLI · remote" code={cliBlock(base, key)} />
            <CopyBlock label="Claude Code skill" code={skillDoc(base, key)} />
            <CopyBlock label="MCP" code={mcpJson(base, key)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
