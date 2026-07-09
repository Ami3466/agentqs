"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Spinner, Waveform, X } from "./icons";
import { cn } from "./ui";

interface Capability {
  enabled: boolean;
  provider: string;
  keyConfigured: boolean;
  agentConfigured: boolean;
  reason: string;
}

/**
 * The in-chat live voice session toggle — wired for ElevenLabs Conversational AI
 * or Gemini Live, whichever Settings → Voice picks. Config-gated: unconfigured it
 * explains what to set; configured, starting it mints real credentials (an
 * ElevenLabs signed URL, or a single-use Gemini ephemeral token) the audio
 * widget connects with. Distinct from the global voice memo.
 */
const PROVIDER_LABEL: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  "google-live": "Gemini Live",
};

export function VoiceSession() {
  const [cap, setCap] = useState<Capability | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/voice/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setCap(d as Capability))
      .catch(() => {});
    return () => {
      alive = false;
    };
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

  async function start() {
    setStarting(true);
    setError("");
    try {
      const res = await fetch("/api/voice/session", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not start the voice session.");
        return;
      }
      // Stub: the audio widget would mount against the minted credential here —
      // data.signedUrl (ElevenLabs) or data.token (Gemini Live). We flip to an
      // active indicator.
      setActive(true);
    } catch {
      setError("Could not reach the voice session endpoint.");
    } finally {
      setStarting(false);
    }
  }

  function end() {
    setActive(false);
    setError("");
  }

  const provider = PROVIDER_LABEL[cap?.provider ?? ""] ?? "ElevenLabs";

  return (
    <div className="static shrink-0 sm:relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Live voice session (${provider})`}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors",
          active
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-border bg-card text-muted-fg hover:bg-muted hover:text-fg",
        )}
      >
        {active ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
        ) : (
          <Waveform width={14} height={14} />
        )}
        <span className="hidden sm:inline">{active ? "Live" : "Voice"}</span>
      </button>

      {open ? (
        <div className="absolute bottom-full left-2 right-2 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:left-0 sm:right-auto sm:w-72 sm:max-w-[calc(100vw-2rem)]">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Waveform width={14} height={14} className="text-accent" />
            <span className="text-[13px] font-semibold text-fg">Live voice session</span>
            <span className="ml-auto rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">
              {provider}
            </span>
          </div>

          <div className="p-3">
            {active ? (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-accent">
                  <Check width={13} height={13} /> Session active
                </div>
                <p className="text-[12px] text-muted-fg">
                  The {provider} audio widget streams here — key points write back to the record on
                  close.
                </p>
                <button
                  type="button"
                  onClick={end}
                  className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-border/60"
                >
                  <X width={14} height={14} /> End session
                </button>
              </div>
            ) : cap && !cap.enabled ? (
              <div>
                <p className="text-[12px] text-muted-fg">
                  Talk it out in real time — premium voice + turn-taking, grounded in the record.
                  Pick ElevenLabs or Gemini Live under Settings → Voice.
                </p>
                <p className="mt-2 rounded-lg border border-border bg-muted px-2.5 py-2 text-[12px] text-muted-fg">
                  {cap.reason}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <Gate ok={cap.keyConfigured} label="API key" />
                  {cap.provider === "elevenlabs" ? <Gate ok={cap.agentConfigured} label="Agent id" /> : null}
                </div>
              </div>
            ) : (
              <div>
                <p className="text-[12px] text-muted-fg">
                  Start a real-time voice conversation grounded in the record — {provider} speaks
                  and listens with natural turn-taking.
                </p>
                {error ? (
                  <p className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[12px] text-destructive">
                    {error}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={starting || !cap}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {starting ? <Spinner width={15} height={15} /> : <Waveform width={15} height={15} />}
                  {starting ? "Connecting…" : "Start voice session"}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Gate({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium",
        ok ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-muted text-muted-fg",
      )}
    >
      {ok ? <Check width={10} height={10} /> : <X width={10} height={10} />} {label}
    </span>
  );
}
