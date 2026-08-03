import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { effectiveProviders, linkedApiKey, readConfig } from "@/lib/config";
import { recordDir } from "@/lib/paths";
import { appendInboxItem, landInboxCaptures, readInboxFromRecord } from "@/lib/record";
import { autoStructureNewItem } from "@/lib/structure-run";
import { describeStt, transcribeMemo, type SttEnv } from "@/lib/voice";
import { whisperInstalled } from "@/lib/whisper-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Guard against a hostile upload; a spoken memo is small.
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB (also OpenAI Whisper's file cap)

/** Build the STT environment from process.env + config. WHISPER_BIN wins; then the
 *  built-in Whisper installed from Settings (only while its weights are actually on
 *  disk, so the mic capability stays truthful); then the cloud backends — the
 *  Settings voice provider's key (ElevenLabs / Google Live) makes the mic work with
 *  no extra setup, and an OpenAI or Google provider key stays the fallback. */
function sttEnv(): SttEnv {
  const cfg = readConfig();
  const providers = effectiveProviders(cfg);
  const openaiAcct = providers.find((p) => p.type === "openai" && p.apiKey);
  const googleAcct = providers.find((p) => p.type === "google" && p.apiKey);
  const voice = cfg?.voice;
  const voiceKey = linkedApiKey(cfg, voice?.providerId, voice?.apiKey);
  const installed = voice?.whisperModel || "";
  return {
    whisperBin: process.env.WHISPER_BIN || "",
    whisperArgs: process.env.WHISPER_ARGS || "",
    whisperModel: installed && whisperInstalled(installed) ? installed : "",
    whisperLang: voice?.whisperLang || "en",
    openaiKey: process.env.OPENAI_API_KEY || openaiAcct?.apiKey || "",
    openaiModel: process.env.WHISPER_MODEL || "whisper-1",
    elevenLabsKey:
      (voice?.provider === "elevenlabs" ? voiceKey : "") || process.env.ELEVENLABS_API_KEY || "",
    geminiKey:
      (voice?.provider === "google-live" ? voiceKey : "") ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      googleAcct?.apiKey ||
      "",
    geminiModel: process.env.GEMINI_STT_MODEL || "",
    prefer: voice?.provider || "",
  };
}

/** Capability probe for the mic button — is anything wired to transcribe? */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(describeStt(sttEnv()));
}

/**
 * A voice memo. Accepts the recorded audio (multipart `audio`, or a raw audio/*
 * body), transcribes it with the configured backend, and appends the transcript
 * to the inbox verbatim — source `voice`, status pending, no LLM parse and no
 * daily row, exactly like a typed `//` memo. The cache is rebuilt so the memo is
 * immediately visible. Returns the transcript + the new pending count.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // Read the audio from either a multipart form (the browser mic) or a raw body.
  let audio: Buffer;
  let mime = "";
  let filename = "";
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("audio");
      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "No audio in the upload (field `audio`)." }, { status: 400 });
      }
      audio = Buffer.from(await file.arrayBuffer());
      mime = file.type || "";
      filename = file.name || "";
    } else {
      audio = Buffer.from(await req.arrayBuffer());
      mime = ct.split(";")[0].trim();
    }
  } catch (e) {
    return NextResponse.json({ error: `Could not read the audio: ${(e as Error).message}` }, { status: 400 });
  }

  if (!audio.length) {
    return NextResponse.json({ error: "The recording was empty." }, { status: 400 });
  }
  if (audio.length > MAX_BYTES) {
    return NextResponse.json({ error: "That recording is too large (max 25 MB)." }, { status: 413 });
  }

  const env = sttEnv();
  const stt = describeStt(env);
  if (!stt.ready) {
    // Config-gated: no transcriber wired. 501 so the mic can show the setup hint.
    return NextResponse.json({ error: stt.label }, { status: 501 });
  }

  let text: string;
  let backend: string;
  try {
    ({ text, backend } = await transcribeMemo({ audio, mime, filename }, env));
  } catch (e) {
    if (env.whisperModel && env.openaiKey) {
      try {
        ({ text, backend } = await transcribeMemo(
          { audio, mime, filename },
          { ...env, whisperModel: "" },
        ));
      } catch {
        return NextResponse.json({ error: `Transcription failed: ${(e as Error).message}` }, { status: 502 });
      }
    } else {
      return NextResponse.json({ error: `Transcription failed: ${(e as Error).message}` }, { status: 502 });
    }
  }

  text = text.trim();
  if (!text) {
    return NextResponse.json(
      { error: "Nothing was heard in that recording — try again.", empty: true },
      { status: 422 },
    );
  }

  const rDir = recordDir();
  const item = appendInboxItem(
    {
      text,
      source: "voice",
      kind: "audio",
      meta: { transcribedBy: backend, mime: mime || undefined, bytes: audio.length },
    },
    { recordDir: rDir },
  );
  // Auto-structure first: when it merges, structurePending lands the capture
  // itself — landing it here too would run the derivation twice per capture.
  const auto = await autoStructureNewItem(item.id); // Settings: skip the pending queue
  if (!auto || auto.structured === 0) landInboxCaptures([item], { recordDir: rDir });

  // The inbox stream ONLY — readRecord would parse events.jsonl (hundreds of MB)
  // to count pending captures.
  const pending = auto?.pending ?? readInboxFromRecord(rDir).filter((i) => i.status === "pending").length;
  return NextResponse.json({
    ok: true,
    id: item.id,
    text,
    backend,
    pending,
    structured: (auto?.structured ?? 0) > 0,
  });
}
