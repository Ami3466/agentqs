"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Spinner, Terminal } from "./icons";
import { cn } from "./ui";

/** Connect / API: mint the instance key, copy the sync command / skill / MCP snippets with it filled in. Kept deliberately tiny. */

export const PH = "AQS_KEY_HERE";
export const SYNC_CMD = "agentqs sync --source github";
export const skillSnip = (b: string, k: string) =>
  `---\nname: agentqs\ndescription: Query the agentqs life-record.\n---\nAPI ${b}, header: authorization: Bearer ${k}\n- POST /api/chat {"message":"…"}   - GET /api/journal   - POST /api/inbox {"text":"…"}`;
export const mcpSnip = (b: string, k: string) =>
  `claude mcp add-json agentqs '{"command":"agentqs","args":["serve","--mcp"],"env":{"AGENTQS_URL":"${b}","AGENTQS_KEY":"${k}"}}'`;

/** Small copy state hook: flips a checkmark for 1.2s after writing to the clipboard. */
function useCopy(): [boolean, (code: string) => void] {
  const [done, setDone] = useState(false);
  return [
    done,
    (code: string) => {
      navigator.clipboard?.writeText(code);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    },
  ];
}

/** Centered label + copy icon, side-by-side use (Copy mcp · Copy skill). */
export function CopyRow({ label, code, className }: { label: string; code: string; className?: string }) {
  const [done, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(code)}
      className={cn(
        "flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-muted",
        className,
      )}
    >
      {done ? <Check width={13} height={13} className="shrink-0 text-accent" /> : <Copy width={13} height={13} className="shrink-0 text-muted-fg" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The CLI one-liner shown verbatim in a terminal-style row with its own copy button. */
export function CliRow({ code }: { code: string }) {
  const [done, copy] = useCopy();
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-2.5 pr-1">
      <Terminal width={13} height={13} className="shrink-0 text-muted-fg" />
      <code className="scrollbar-none flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-fg">{code}</code>
      <button
        type="button"
        onClick={() => copy(code)}
        aria-label="Copy command"
        className="shrink-0 rounded-md p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-fg"
      >
        {done ? <Check width={13} height={13} className="text-accent" /> : <Copy width={13} height={13} />}
      </button>
    </div>
  );
}

/** The freshly minted key with its own copy button — shown once right after generating. */
export function KeyRow({ value }: { value: string }) {
  const [done, copy] = useCopy();
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 py-1 pl-2.5 pr-1">
      <code className="scrollbar-none flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-fg">{value}</code>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label="Copy API key"
        className="shrink-0 rounded-md p-1.5 text-muted-fg transition-colors hover:bg-muted hover:text-fg"
      >
        {done ? <Check width={13} height={13} className="text-accent" /> : <Copy width={13} height={13} />}
      </button>
    </div>
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
        <div className="fixed inset-x-3 top-16 z-50 space-y-2 rounded-xl border border-border bg-card p-3 shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[340px]">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Spinner width={14} height={14} /> : null}
            {fullKey ? "New key generated" : masked ? `Regenerate API key · ${masked}` : "Generate API key"}
          </button>
          {fullKey ? <KeyRow value={fullKey} /> : null}
          <CliRow code={SYNC_CMD} />
          <div className="flex gap-2">
            <CopyRow label="Copy mcp" code={mcpSnip(base, key)} className="flex-1" />
            <CopyRow label="Copy skill" code={skillSnip(base, key)} className="flex-1" />
          </div>
          <p className="pt-0.5 text-center text-[12px] text-muted-fg">
            or work directly in your forked repo — the record is plain files in your own git repo.
          </p>
        </div>
      ) : null}
    </div>
  );
}
