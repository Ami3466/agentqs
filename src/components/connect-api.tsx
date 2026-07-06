"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Spinner, Terminal } from "./icons";
import { cn } from "./ui";

/** Connect / API: mint the instance key, copy the CLI / skill / MCP snippets with it filled in. Kept deliberately tiny. */

const PH = "AQS_KEY_HERE";
const cliSnip = (b: string, k: string) =>
  `export AGENTQS_URL=${b} AGENTQS_KEY=${k}\nagentqs chat "why have I felt off this week?"`;
const skillSnip = (b: string, k: string) =>
  `---\nname: agentqs\ndescription: Query the user's agentqs life-record + mentor.\n---\nAPI ${b}, header: authorization: Bearer ${k}\n- POST /api/chat {"message":"…"}   - GET /api/journal   - POST /api/inbox {"text":"…"}`;
const mcpSnip = (b: string, k: string) =>
  `claude mcp add-json agentqs '{"command":"agentqs","args":["serve","--mcp"],"env":{"AGENTQS_URL":"${b}","AGENTQS_KEY":"${k}"}}'`;

function CopyRow({ label, code }: { label: string; code: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(code);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-[13px] text-fg transition-colors hover:bg-muted"
    >
      {label}
      {done ? <Check width={14} height={14} /> : <Copy width={14} height={14} className="text-muted-fg" />}
    </button>
  );
}

export function ConnectApi() {
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState("http://localhost:3000");
  const [masked, setMasked] = useState("");
  const [fullKey, setFullKey] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const key = fullKey || masked || PH;

  useEffect(() => {
    if (typeof window !== "undefined") setBase(window.location.origin);
  }, []);
  useEffect(() => {
    if (!open) return;
    fetch("/api/keys").then((r) => (r.ok ? r.json() : null)).then((d) => d && setMasked(d.masked || "")).catch(() => {});
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
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
      const d = await fetch("/api/keys", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
      if (d.key) { setFullKey(d.key); setMasked(d.masked || ""); }
    } finally { setBusy(false); }
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
        <span className="hidden sm:inline">Connect</span>
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[340px] max-w-[calc(100vw-2rem)] space-y-2 rounded-xl border border-border bg-card p-3 shadow-xl">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Spinner width={14} height={14} /> : null}
            {fullKey ? "New key generated" : masked ? `Regenerate API key · ${masked}` : "Generate API key"}
          </button>
          {fullKey ? <p className="px-1 font-mono text-[12px] text-muted-fg break-all">{fullKey}</p> : null}
          <CopyRow label="Copy CLI" code={cliSnip(base, key)} />
          <CopyRow label="Copy skill" code={skillSnip(base, key)} />
          <CopyRow label="Copy MCP" code={mcpSnip(base, key)} />
        </div>
      ) : null}
    </div>
  );
}
