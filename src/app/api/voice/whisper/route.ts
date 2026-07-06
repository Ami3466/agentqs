import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { readConfig, writeConfig } from "@/lib/config";
import {
  WHISPER_MODELS,
  installWhisperModel,
  removeWhisperModel,
  whisperInstalled,
} from "@/lib/whisper-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Settings → Voice memos payload: which built-in Whisper models exist, what's
 *  on disk, and which one memos actually use. */
function status() {
  const cfg = readConfig();
  const active = cfg?.voice?.whisperModel || "";
  return {
    active: active && whisperInstalled(active) ? active : "",
    lang: cfg?.voice?.whisperLang || "en",
    models: WHISPER_MODELS.map((m) => ({
      id: m.id,
      size: m.size,
      hint: m.hint,
      installed: whisperInstalled(m.id),
    })),
  };
}

/** GET — install status for the Settings section. */
export async function GET() {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  return NextResponse.json(status());
}

/**
 * POST { model } — install the built-in local Whisper: transformers.js downloads
 * the quantized ONNX weights once into data/models (same cache as the embedder),
 * then the model is marked active so memos transcribe on-device. Re-POSTing an
 * installed model just switches to it.
 */
export async function POST(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!readConfig()) return NextResponse.json({ error: "No config." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const model = typeof body.model === "string" ? body.model : "";
  if (!WHISPER_MODELS.some((m) => m.id === model)) {
    return NextResponse.json({ error: "Unknown Whisper model." }, { status: 400 });
  }

  try {
    await installWhisperModel(model); // downloads on first install, verifies after
  } catch (e) {
    return NextResponse.json(
      { error: `Could not download the model (offline?): ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const latest = readConfig();
  if (latest) {
    latest.voice = { ...latest.voice, provider: latest.voice?.provider || "", whisperModel: model };
    writeConfig(latest);
  }
  return NextResponse.json({ ok: true, ...status() });
}

/** DELETE [?model=id] — remove a model's weights from disk; deactivates it when it
 *  was the active transcriber. Defaults to the active model. */
export async function DELETE(req: Request) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const cfg = readConfig();
  if (!cfg) return NextResponse.json({ error: "No config." }, { status: 400 });

  const requested = new URL(req.url).searchParams.get("model") || "";
  const model = requested || cfg.voice?.whisperModel || "";
  if (!WHISPER_MODELS.some((m) => m.id === model)) {
    return NextResponse.json({ error: "No installed Whisper model to remove." }, { status: 400 });
  }

  removeWhisperModel(model);
  if (cfg.voice?.whisperModel === model) {
    cfg.voice = { ...cfg.voice, provider: cfg.voice.provider || "", whisperModel: "" };
    writeConfig(cfg);
  }
  return NextResponse.json({ ok: true, ...status() });
}
