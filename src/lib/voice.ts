import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Speech-to-text for voice memos — a small pluggable contract with two real
 * backends. A voice memo is: record audio in the browser → POST the bytes here →
 * transcribe → the text lands raw in the inbox (no LLM, no daily row), exactly
 * like a typed `//` memo. Transcription is the ONLY external step, and it's
 * swappable:
 *
 *   - local         — a local command (whisper.cpp / faster-whisper / any wrapper)
 *                     set via WHISPER_BIN. agentqs writes the audio to a temp file,
 *                     runs `WHISPER_BIN [WHISPER_ARGS…] <audiofile>`, and reads the
 *                     transcript from stdout. For users who already run an engine.
 *   - whisper-local — the built-in Whisper, installed INTO the project from
 *                     Settings → Voice memos: a quantized ONNX model downloaded
 *                     once into data/models and run via transformers.js
 *                     (whisper-local.ts). No binary, no key, no cloud.
 *   - openai        — OpenAI Whisper (whisper-1) over HTTP, used when nothing
 *                     local is set but an OpenAI key is available. The cloud
 *                     fallback.
 *   - elevenlabs    — ElevenLabs Scribe over HTTP; enabled by the same key the
 *                     live voice session uses, so picking ElevenLabs in Settings
 *                     makes the mic work with no extra setup.
 *   - gemini        — Gemini audio understanding over HTTP (generateContent with
 *                     inline audio); enabled by a Google provider key or the
 *                     Google Live voice key.
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
  whisperModel?: string; // built-in local Whisper installed from Settings ("tiny" | "base" | "small")
  whisperLang?: string; // spoken language for the built-in model (default "en")
  openaiKey?: string; // OPENAI_API_KEY, or the config key when provider=openai
  openaiModel?: string; // default whisper-1
  elevenLabsKey?: string; // ELEVENLABS_API_KEY, or the Settings voice key when provider=elevenlabs
  geminiKey?: string; // GEMINI_API_KEY/GOOGLE_API_KEY, a Google provider key, or the Google Live voice key
  geminiModel?: string; // default gemini-flash-latest (GEMINI_STT_MODEL overrides)
  prefer?: "" | "elevenlabs" | "google-live"; // the Settings voice provider — wins among cloud backends
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

// ---- Built-in local Whisper (transformers.js, installed from Settings) -----

/**
 * The built-in local model — Whisper as a quantized ONNX model downloaded into
 * data/models from Settings → Voice memos and run in-process via transformers.js
 * (like the text embedder). Fully on-device after the one-time download. Imported
 * lazily so this module stays light and pure for tests.
 */
export function whisperModelBackend(model: string, lang?: string): SttBackend {
  return {
    id: "whisper-local",
    label: `Local Whisper (${model}, on-device)`,
    async transcribe({ audio }) {
      const { transcribeWhisper } = await import("./whisper-local");
      return transcribeWhisper(audio, model, lang);
    },
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

// ---- ElevenLabs Scribe backend (HTTP) --------------------------------------

export function elevenLabsSttBackend(apiKey: string, fetchImpl: typeof fetch = fetch): SttBackend {
  return {
    id: "elevenlabs",
    label: "ElevenLabs Scribe",
    async transcribe({ audio, mime, filename, signal }) {
      const form = new FormData();
      const blob = new Blob([audio as unknown as BlobPart], { type: mime || "audio/webm" });
      form.append("file", blob, filename || `memo${extFor(mime, filename)}`);
      form.append("model_id", "scribe_v1");
      const res = await fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
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
        const j = json as { detail?: { message?: string } | string };
        const msg = (typeof j.detail === "object" ? j.detail?.message : j.detail) || text || res.statusText;
        throw new Error(`ElevenLabs ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      }
      return String((json as { text?: unknown }).text ?? "").trim();
    },
  };
}

// ---- Gemini audio backend (HTTP) -------------------------------------------

export function geminiSttBackend(
  apiKey: string,
  model = "gemini-flash-latest",
  fetchImpl: typeof fetch = fetch,
): SttBackend {
  return {
    id: "gemini",
    label: `Gemini (${model})`,
    async transcribe({ audio, mime, signal }) {
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: "Transcribe this audio verbatim. Reply with ONLY the transcript — no preamble, no quotes." },
                  { inline_data: { mime_type: mime || "audio/webm", data: audio.toString("base64") } },
                ],
              },
            ],
          }),
          signal,
        },
      );
      const text = await res.text();
      let json: unknown = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* surfaced below */
      }
      if (!res.ok) {
        const j = json as { error?: { message?: string } };
        throw new Error(`Gemini ${res.status}: ${j.error?.message || text || res.statusText}`);
      }
      const parts = (json as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]
        ?.content?.parts;
      return (parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    },
  };
}

// ---- Resolution + description --------------------------------------------

/** Pick the active backend from the environment. A local binary is an explicit
 *  opt-in and always wins; then the built-in Whisper installed from Settings;
 *  then the cloud backends — the Settings voice provider (ElevenLabs / Google
 *  Live) is an explicit pick and beats the key-presence fallbacks (OpenAI, then
 *  ElevenLabs, then Gemini); otherwise there's no STT and the mic surfaces a
 *  setup hint. */
export function resolveSttBackend(env: SttEnv): SttBackend | null {
  const f = env.fetchImpl ?? fetch;
  if (env.whisperBin && env.whisperBin.trim()) {
    return localWhisperBackend(env.whisperBin.trim(), splitArgs(env.whisperArgs));
  }
  if (env.whisperModel && env.whisperModel.trim()) {
    return whisperModelBackend(env.whisperModel.trim(), env.whisperLang?.trim());
  }
  const elevenlabs = env.elevenLabsKey?.trim()
    ? elevenLabsSttBackend(env.elevenLabsKey.trim(), f)
    : null;
  const gemini = env.geminiKey?.trim()
    ? geminiSttBackend(env.geminiKey.trim(), env.geminiModel?.trim() || "gemini-flash-latest", f)
    : null;
  if (env.prefer === "elevenlabs" && elevenlabs) return elevenlabs;
  if (env.prefer === "google-live" && gemini) return gemini;
  if (env.openaiKey && env.openaiKey.trim()) {
    return openaiWhisperBackend(env.openaiKey.trim(), env.openaiModel?.trim() || "whisper-1", f);
  }
  return elevenlabs ?? gemini;
}

export interface SttStatus {
  ready: boolean;
  backend: string | null; // "local" | "whisper-local" | "openai" | "elevenlabs" | "gemini" | null
  label: string;
}

/** Capability for the mic UI — what (if anything) will transcribe a memo. */
export function describeStt(env: SttEnv): SttStatus {
  const b = resolveSttBackend(env);
  if (b) return { ready: true, backend: b.id, label: b.label };
  return {
    ready: false,
    backend: null,
    label:
      "No speech-to-text configured — install Whisper under Settings → Voice memos, pick a voice provider (ElevenLabs / Google Live), or add an OpenAI key.",
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

// ---- Live voice session (ElevenLabs Conversational AI / Gemini Live) ------

/**
 * The in-chat live voice session — premium voice + turn-taking, with key points
 * written back to the record. Two providers, picked in Settings → Voice:
 *
 *   - elevenlabs  — Conversational AI; needs an API key + an agent id (the
 *                   agent's brain is configured to Claude in the ElevenLabs
 *                   dashboard). The server mints a signed URL to connect to.
 *   - google-live — Gemini Live; needs only a Gemini API key (a Google provider
 *                   key can be linked). The server mints a single-use ephemeral
 *                   token the browser uses as its API key, so the real key
 *                   never leaves this machine.
 *
 * Config-gated: the toggle stays a stub until the provider's requirements are
 * present. This is the real capability probe the UI + the session route share.
 */
export interface SessionEnv {
  provider?: "" | "elevenlabs" | "google-live"; // Settings voice provider; "" falls back to elevenlabs env vars
  elevenLabsKey?: string; // ELEVENLABS_API_KEY
  elevenLabsAgentId?: string; // ELEVENLABS_AGENT_ID
  googleKey?: string; // Gemini API key (Settings voice key, a linked Google provider, or GEMINI_API_KEY)
  googleModel?: string; // Live model, default gemini-2.5-flash-native-audio-preview-09-2025
  fetchImpl?: typeof fetch;
}

export interface SessionStatus {
  enabled: boolean;
  provider: "elevenlabs" | "google-live";
  keyConfigured: boolean;
  agentConfigured: boolean; // ElevenLabs only; always true for Google Live
  reason: string; // why it's disabled (empty when enabled)
}

export function describeSession(env: SessionEnv): SessionStatus {
  if (env.provider === "google-live") {
    const keyConfigured = Boolean(env.googleKey && env.googleKey.trim());
    return {
      enabled: keyConfigured,
      provider: "google-live",
      keyConfigured,
      agentConfigured: true,
      reason: keyConfigured ? "" : "Add a Gemini API key under Settings → Voice to enable the live voice session.",
    };
  }
  const keyConfigured = Boolean(env.elevenLabsKey && env.elevenLabsKey.trim());
  const agentConfigured = Boolean(env.elevenLabsAgentId && env.elevenLabsAgentId.trim());
  const enabled = keyConfigured && agentConfigured;
  const missing: string[] = [];
  if (!keyConfigured) missing.push("an API key");
  if (!agentConfigured) missing.push("an agent id");
  return {
    enabled,
    provider: "elevenlabs",
    keyConfigured,
    agentConfigured,
    reason: enabled ? "" : `Add ${missing.join(" + ")} under Settings → Voice to enable the live voice session.`,
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

/**
 * Mint a single-use ephemeral token for Gemini Live. Real wiring — POSTs the
 * v1alpha auth_tokens create (the endpoint the official GenAI SDKs call); the
 * returned `name` is what the browser passes as its API key when opening the
 * Live WebSocket, so the real Gemini key never reaches the client. Throws when
 * unconfigured (the caller returns a config-gated 501) or on an upstream error.
 */
export async function geminiLiveToken(env: SessionEnv): Promise<{ token: string; model: string }> {
  const status = describeSession(env);
  if (env.provider !== "google-live" || !status.enabled) {
    throw new Error(status.reason || "The live voice session is not configured for Gemini.");
  }
  const fetchImpl = env.fetchImpl ?? fetch;
  const model = env.googleModel?.trim() || "gemini-2.5-flash-native-audio-preview-09-2025";
  const res = await fetchImpl("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST",
    headers: { "x-goog-api-key": env.googleKey!.trim(), "content-type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* surfaced below */
  }
  if (!res.ok) {
    const j = json as { error?: { message?: string } };
    throw new Error(`Gemini ${res.status}: ${j.error?.message || text || res.statusText}`);
  }
  const token = (json as { name?: unknown }).name;
  if (typeof token !== "string" || !token) throw new Error("Gemini did not return an ephemeral token.");
  return { token, model };
}
