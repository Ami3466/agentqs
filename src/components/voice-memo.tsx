"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AudioLines, Check, Mic, Spinner, Square, X } from "./icons";
import { cn } from "./ui";

type Phase = "idle" | "recording" | "transcribing" | "done" | "error";

interface Capability {
  ready: boolean;
  backend: string | null;
  label: string;
}

interface Result {
  text: string;
  pending: number;
  backend: string;
  structured: boolean; // auto-structure (Settings) merged it straight into daily
}

/** Pick the first mime the browser's MediaRecorder actually supports. */
function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function extForMime(mime: string): string {
  if (mime.includes("webm")) return ".webm";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("ogg")) return ".ogg";
  return ".webm";
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Re-encode the recording as 16 kHz mono 16-bit WAV for the built-in local
 * Whisper: the server can't decode webm/opus without ffmpeg, but the browser can
 * always decode its own recording. Returns null when decoding fails (the caller
 * falls back to uploading the original blob).
 */
async function toWav16k(blob: Blob): Promise<Blob | null> {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx || typeof OfflineAudioContext === "undefined") return null;
    const probe = new Ctx();
    let decoded: AudioBuffer;
    try {
      decoded = await probe.decodeAudioData(await blob.arrayBuffer());
    } finally {
      void probe.close().catch(() => {});
    }
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const pcm = (await offline.startRendering()).getChannelData(0);

    const wav = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) wav.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    wav.setUint32(4, 36 + pcm.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    wav.setUint32(16, 16, true); // fmt chunk size
    wav.setUint16(20, 1, true); // PCM
    wav.setUint16(22, 1, true); // mono
    wav.setUint32(24, 16000, true); // sample rate
    wav.setUint32(28, 32000, true); // byte rate
    wav.setUint16(32, 2, true); // block align
    wav.setUint16(34, 16, true); // bits
    str(36, "data");
    wav.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      wav.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([wav.buffer], { type: "audio/wav" });
  } catch {
    return null;
  }
}

/**
 * The global voice memo — a mic in the top chrome, on every tab. Record → the
 * audio is transcribed by the configured backend (local Whisper or a pluggable
 * STT) → the transcript lands raw in the inbox, no LLM, exactly like a typed `//`
 * memo. Separate from the in-chat live voice session. Config-gated: when no
 * transcriber is wired the mic explains what to set instead of recording.
 */
export function VoiceMemo() {
  const router = useRouter();
  const [cap, setCap] = useState<Capability | null>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const ref = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const active = phase === "recording" || phase === "transcribing";

  // Capability probe — is anything wired to transcribe a memo?
  useEffect(() => {
    let alive = true;
    fetch("/api/voice/memo")
      .then((r) => (r.ok ? r.json() : { ready: false, backend: null, label: "Sign in to record." }))
      .then((d) => alive && setCap(d as Capability))
      .catch(() => alive && setCap({ ready: false, backend: null, label: "Voice unavailable." }));
    return () => {
      alive = false;
    };
  }, []);

  // Close on outside click / Escape — but never while recording (that would hide
  // the live controls with the mic still hot).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (active) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !active && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, active]);

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  useEffect(() => () => {
    stopTimer();
    releaseStream();
  }, []);

  async function startRecording() {
    setError("");
    setResult(null);
    setElapsed(0);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setError("This browser can't access the microphone.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase("error");
      setError("Microphone permission was denied.");
      return;
    }
    streamRef.current = stream;
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorderRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => void upload(rec.mimeType || mime || "audio/webm");
    rec.start();
    setPhase("recording");
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  }

  function stopRecording() {
    stopTimer();
    setPhase("transcribing");
    try {
      recorderRef.current?.stop(); // fires onstop → upload
    } catch {
      /* already stopped */
    }
  }

  function cancelRecording() {
    stopTimer();
    try {
      const rec = recorderRef.current;
      if (rec) rec.onstop = null;
      rec?.stop();
    } catch {
      /* noop */
    }
    releaseStream();
    chunksRef.current = [];
    setPhase("idle");
    setOpen(false);
  }

  async function upload(mime: string) {
    releaseStream();
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (!blob.size) {
      setPhase("error");
      setError("The recording was empty.");
      return;
    }
    try {
      // The built-in local Whisper consumes raw PCM — hand it WAV, decoded here.
      let payload = blob;
      let name = `memo${extForMime(mime)}`;
      if (cap?.backend === "whisper-local") {
        const wav = await toWav16k(blob);
        if (wav) {
          payload = wav;
          name = "memo.wav";
        }
      }
      const form = new FormData();
      form.append("audio", payload, name);
      const res = await fetch("/api/voice/memo", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase("error");
        setError(data.error || "Could not transcribe that memo.");
        return;
      }
      setResult({ text: data.text, pending: data.pending, backend: data.backend, structured: Boolean(data.structured) });
      setPhase("done");
      router.refresh(); // so the Data-tab inbox reflects the new memo
    } catch {
      setPhase("error");
      setError("Could not reach the transcriber.");
    }
  }

  function onButton() {
    if (active) return;
    if (!open) {
      setOpen(true);
      if (cap?.ready) void startRecording();
      return;
    }
    setOpen(false);
  }

  const buttonTitle = cap?.ready
    ? "Record a voice memo"
    : cap
      ? "Voice memo — not configured"
      : "Voice memo";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={onButton}
        aria-label={buttonTitle}
        title={buttonTitle}
        className={cn(
          "relative inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          phase === "recording"
            ? "border-destructive/50 bg-destructive/10 text-destructive"
            : "border-border bg-card text-muted-fg hover:bg-muted hover:text-fg",
        )}
      >
        <Mic width={16} height={16} />
        {phase === "recording" ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-16 z-50 rounded-xl border border-border bg-card p-4 shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[300px]">
          <Panel
            cap={cap}
            phase={phase}
            elapsed={elapsed}
            error={error}
            result={result}
            onStart={() => void startRecording()}
            onStop={stopRecording}
            onCancel={cancelRecording}
            onClose={() => {
              setPhase("idle");
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Panel({
  cap,
  phase,
  elapsed,
  error,
  result,
  onStart,
  onStop,
  onCancel,
  onClose,
}: {
  cap: Capability | null;
  phase: Phase;
  elapsed: number;
  error: string;
  result: Result | null;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const header = useMemo(
    () => (
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-muted text-accent">
          <AudioLines width={15} height={15} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg">Voice memo</p>
          <p className="truncate text-[11px] text-muted-fg">
            {cap?.ready ? cap.label : "Transcribes into the inbox"}
          </p>
        </div>
      </div>
    ),
    [cap],
  );

  // Not configured — config-gated setup hint, no recording.
  if (cap && !cap.ready) {
    return (
      <div>
        {header}
        <p className="text-[13px] text-muted-fg">{cap.label}</p>
        <p className="mt-2 text-[12px] text-muted-fg">
          Install Whisper locally under{" "}
          <a href="/settings#memos" className="font-medium text-fg underline decoration-border underline-offset-2 hover:text-accent">
            Settings → Voice memos
          </a>{" "}
          for private, offline transcription — or add an OpenAI key to use hosted Whisper.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-lg border border-border bg-muted px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-border/60"
        >
          Got it
        </button>
      </div>
    );
  }

  if (phase === "recording") {
    return (
      <div>
        {header}
        <div className="flex items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 py-3 text-destructive">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-destructive" />
          </span>
          <span className="font-mono text-lg font-medium tabular-nums">{fmt(elapsed)}</span>
          <span className="text-[12px] font-medium">recording</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-muted-fg transition-colors hover:bg-muted hover:text-fg"
          >
            <X width={14} height={14} /> Cancel
          </button>
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            <Square width={13} height={13} /> Stop
          </button>
        </div>
      </div>
    );
  }

  if (phase === "transcribing") {
    return (
      <div>
        {header}
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-fg">
          <Spinner width={16} height={16} /> Transcribing…
        </div>
      </div>
    );
  }

  if (phase === "done" && result) {
    return (
      <div>
        {header}
        <div className="rounded-lg border border-accent/40 bg-accent/10 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-accent">
            <Check width={12} height={12} />{" "}
            {result.structured ? "memo structured into daily" : "memo saved to inbox"} · {result.pending} pending
          </div>
          <p className="text-[13px] text-fg">{result.text}</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-muted"
          >
            <Mic width={14} height={14} /> Again
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div>
        {header}
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-[13px] text-destructive">
          {error}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-muted"
          >
            <Mic width={14} height={14} /> Retry
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-muted px-3 py-2 text-[13px] font-medium text-fg transition-colors hover:bg-border/60"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // idle (before the mic stream opens)
  return (
    <div>
      {header}
      <button
        type="button"
        onClick={onStart}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90"
      >
        <Mic width={15} height={15} /> Start recording
      </button>
    </div>
  );
}
