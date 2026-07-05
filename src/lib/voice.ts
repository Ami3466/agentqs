import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Speech-to-text for voice memos — a small pluggable contract with two real
 * backends. A voice memo is: record audio in the browser → POST the bytes here →
 * transcribe → the text lands raw in the inbox (no LLM, no daily row), exactly
 * like a typed `>>` memo. Transcription is the ONLY external step, and it's
 * swappable:
 *
 *   - local   — a local command (whisper.cpp / faster-whisper / any wrapper) set
 *               via WHISPER_BIN. agentqs writes the audio to a temp file, runs
 *               `WHISPER_BIN [WHISPER_ARGS…] <audiofile>`, and reads the transcript
 *               from stdout. Private, no key, no cost — the plan's default.
 *   - openai  — OpenAI Whisper (whisper-1) over HTTP, used when no local binary is
 *               set but an OpenAI key is available. The pluggable cloud fallback.
 *
 * Server-only (spawns processes, touches the fs). The API route builds the env
 * from config + process.env; nothing here reads config, so it stays pure and
 * testable — a backend is chosen from a plain `SttEnv`.
 */

export interface TranscribeInput {
  audio: Buffer;
  mime?: string; // e.g. "audio/webm" — from the browser MediaRecorder
  filename?: string; // e.g. "memo.webm"
  signal?: AbortSignal;
}

export interface SttBackend {
  id: string; // "local" | "openai"
  label: string; // human-readable, shown in the mic UI
  transcribe(input: TranscribeInput): Promise<string>;
}

/** Everything a backend needs, lifted out of config/env so this module is pure. */
export interface SttEnv {
  whisperBin?: string; // WHISPER_BIN — a command that prints a transcript
  whisperArgs?: string; // WHISPER_ARGS — extra args, space-split, before the file
  openaiKey?: string; // OPENAI_API_KEY, or the config key when provider=openai
  openaiModel?: string; // default whisper-1
  fetchImpl?: typeof fetch; // injectable for tests
}

// ---- Helpers --------------------------------------------------------------

/** Best-guess file extension for a temp audio file, so a local transcriber that
 *  sniffs by extension gets a sensible hint. */
function extFor(mime?: string, filename?: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return ".webm";
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return ".m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("wav")) return ".wav";
  const ext = filename ? path.extname(filename) : "";
  return ext || ".webm";
}

function splitArgs(s?: string): string[] {
  return (s || "").trim() ? (s as string).trim().split(/\s+/) : [];
}

// ---- Local backend (whisper.cpp / any wrapper) ----------------------------

/**
 * Run a local transcriber. The contract is deliberately minimal so any engine
 * fits behind one env var: agentqs writes the audio to a temp file and runs
 * `bin [args…] <audiofile>`; whatever the command prints to stdout (trimmed) is
 * the transcript. Wrap whisper.cpp, faster-whisper, or a shell one-liner.
 */
export function localWhisperBackend(bin: string, args: string[] = []): SttBackend {
  return {
    id: "local",
    label: `Local Whisper (${path.basename(bin)})`,
    transcribe: ({ audio, mime, filename, signal }) =>
      new Promise<string>((resolve, reject) => {
        const tmp = path.join(os.tmpdir(), `agentqs-voice-${crypto.randomUUID()}${extFor(mime, filename)}`);
        const cleanup = () => {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            /* best-effort */
          }
        };
        try {
          fs.writeFileSync(tmp, audio);
        } catch (e) {
          reject(new Error(`Could not stage audio for transcription: ${(e as Error).message}`));
          return;
        }
        const child = spawn(bin, [...args, tmp], { stdio: ["ignore", "pipe", "pipe"], signal });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", (e) => {
          cleanup();
          reject(new Error(`Local transcriber "${bin}" failed to start: ${e.message}`));
        });
        child.on("close", (code) => {
          cleanup();
          if (code === 0) resolve(out.trim());
          else reject(new Error(`Local transcriber exited ${code}: ${(err.trim() || out.trim()).slice(0, 300)}`));
        });
      }),
  };
}

// ---- OpenAI Whisper backend (HTTP) ----------------------------------------

export function openaiWhisperBackend(
  apiKey: string,
  model = "whisper-1",
  fetchImpl: typeof fetch = fetch,
): SttBackend {
  return {
    id: "openai",
    label: `OpenAI Whisper (${model})`,
    async transcribe({ audio, mime, filename, signal }) {
      const form = new FormData();
      const blob = new Blob([audio as unknown as BlobPart], { type: mime || "audio/webm" });
      form.append("file", blob, filename || `memo${extFor(mime, filename)}`);
      form.append("model", model);
      const res = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      const text = await res.text();
      let json: unknown = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* surfaced below */
      }
      if (!res.ok) {
        const j = json as { error?: { message?: string } | string };
        const msg =
          (typeof j.error === "object" ? j.error?.message : j.error) || text || res.statusText;
        throw new Error(`${res.status} ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      }
      return String((json as { text?: unknown }).text ?? "").trim();
    },
  };
}

// ---- Resolution + description --------------------------------------------

/** Pick the active backend from the environment. A local binary is an explicit
 *  opt-in and always wins; otherwise an OpenAI key enables the cloud fallback;
 *  otherwise there's no STT and the mic surfaces a setup hint. */
export function resolveSttBackend(env: SttEnv): SttBackend | null {
  if (env.whisperBin && env.whisperBin.trim()) {
    return localWhisperBackend(env.whisperBin.trim(), splitArgs(env.whisperArgs));
  }
  if (env.openaiKey && env.openaiKey.trim()) {
    return openaiWhisperBackend(env.openaiKey.trim(), env.openaiModel?.trim() || "whisper-1", env.fetchImpl ?? fetch);
  }
  return null;
}

export interface SttStatus {
  ready: boolean;
  backend: string | null; // "local" | "openai" | null
  label: string;
}

/** Capability for the mic UI — what (if anything) will transcribe a memo. */
export function describeStt(env: SttEnv): SttStatus {
  const b = resolveSttBackend(env);
  if (b) return { ready: true, backend: b.id, label: b.label };
  return {
    ready: false,
    backend: null,
    label: "No speech-to-text configured — set WHISPER_BIN for local Whisper, or an OpenAI key.",
  };
}

/** Transcribe with the resolved backend; throws a clear error when none is set. */
export async function transcribeMemo(input: TranscribeInput, env: SttEnv): Promise<{ text: string; backend: string }> {
  const backend = resolveSttBackend(env);
  if (!backend) {
    throw new Error(describeStt(env).label);
  }
  const text = await backend.transcribe(input);
  return { text, backend: backend.id };
}

// ---- Live voice session (ElevenLabs Conversational AI) --------------------

/**
 * The in-chat live voice session is ElevenLabs Conversational AI — premium voice
 * + turn-taking, with the agent's brain configured to Claude in the ElevenLabs
 * dashboard, and key points written back to the record. It's config-gated: the
 * toggle stays a stub until both an API key and an agent id are present. This is
 * the real capability probe the UI + the session route share.
 */
export interface SessionEnv {
  elevenLabsKey?: string; // ELEVENLABS_API_KEY
  elevenLabsAgentId?: string; // ELEVENLABS_AGENT_ID
  fetchImpl?: typeof fetch;
}

export interface SessionStatus {
  enabled: boolean;
  provider: "elevenlabs";
  keyConfigured: boolean;
  agentConfigured: boolean;
  reason: string; // why it's disabled (empty when enabled)
}

export function describeSession(env: SessionEnv): SessionStatus {
  const keyConfigured = Boolean(env.elevenLabsKey && env.elevenLabsKey.trim());
  const agentConfigured = Boolean(env.elevenLabsAgentId && env.elevenLabsAgentId.trim());
  const enabled = keyConfigured && agentConfigured;
  const missing: string[] = [];
  if (!keyConfigured) missing.push("ELEVENLABS_API_KEY");
  if (!agentConfigured) missing.push("ELEVENLABS_AGENT_ID");
  return {
    enabled,
    provider: "elevenlabs",
    keyConfigured,
    agentConfigured,
    reason: enabled ? "" : `Set ${missing.join(" + ")} to enable the live voice session.`,
  };
}

/**
 * Mint a signed URL the ElevenLabs Conversational AI widget connects to. Real
 * wiring — when the session is configured this calls ElevenLabs' get-signed-url
 * endpoint so the client can open the WebRTC/WebSocket audio channel. Throws when
 * unconfigured (the caller returns a config-gated 501) or on an upstream error.
 */
export async function elevenLabsSignedUrl(env: SessionEnv): Promise<string> {
  const status = describeSession(env);
  if (!status.enabled) throw new Error(status.reason);
  const fetchImpl = env.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(
      env.elevenLabsAgentId!.trim(),
    )}`,
    { headers: { "xi-api-key": env.elevenLabsKey!.trim() } },
  );
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* surfaced below */
  }
  if (!res.ok) {
    const j = json as { detail?: { message?: string } | string };
    const msg = (typeof j.detail === "object" ? j.detail?.message : j.detail) || text || res.statusText;
    throw new Error(`ElevenLabs ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  const url = (json as { signed_url?: unknown }).signed_url;
  if (typeof url !== "string" || !url) throw new Error("ElevenLabs did not return a signed URL.");
  return url;
}
