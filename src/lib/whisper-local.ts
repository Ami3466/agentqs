import fs from "fs";
import path from "path";
import { modelsDir } from "./embedder";
import { createModelSlot, type ModelSlot } from "./model-slot";

/**
 * The built-in local Whisper — speech-to-text that installs INTO the project, the
 * same way the text embedder and CLIP do: a quantized ONNX model downloaded once
 * from Settings → Voice memos into data/models and run via transformers.js. Fully
 * on-device — no key, no cloud, nothing leaves the machine after the download.
 *
 * The mic records webm/opus, which Node can't decode without ffmpeg — so the app
 * converts the recording to 16 kHz mono WAV in the browser (the browser can always
 * decode its own codec) and this module consumes the WAV: parse → mono → resample
 * → Whisper. External callers (CLI / raw API) should send 16 kHz mono WAV too.
 *
 * Server-only (touches the fs, loads onnxruntime). voice.ts imports it lazily so
 * the STT contract stays import-light and testable.
 */

export interface WhisperModelInfo {
  id: string; // "tiny" | "base" | "small" — the id stored in config
  repo: string; // HF repo transformers.js downloads (once) into data/models
  size: string; // approximate one-time download, shown on the install button
  hint: string; // quality/speed hint for the Settings picker
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: "tiny", repo: "Xenova/whisper-tiny", size: "~45 MB", hint: "fastest, rough" },
  { id: "base", repo: "Xenova/whisper-base", size: "~85 MB", hint: "recommended" },
  { id: "small", repo: "Xenova/whisper-small", size: "~265 MB", hint: "best accuracy, slower" },
];

export function whisperRepoFor(model: string): string | null {
  return WHISPER_MODELS.find((m) => m.id === model)?.repo ?? null;
}

/** Are the model's weights already on disk (downloaded into data/models)? */
export function whisperInstalled(model: string): boolean {
  const repo = whisperRepoFor(model);
  if (!repo) return false;
  try {
    return fs.readdirSync(path.join(modelsDir(), repo, "onnx")).some((f) => f.endsWith(".onnx"));
  } catch {
    return false;
  }
}

type AsrOutput = { text?: string } | { text?: string }[];
type AsrPipe = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<AsrOutput>;

// One slot per model size: warm while transcribing, disposed after the idle TTL
// (AGENTQS_MODEL_IDLE_MS) so a single voice memo doesn't park Whisper in RSS forever.
// The map holds slots, not models — an idle slot is empty.
const slots = new Map<string, ModelSlot<AsrPipe>>();

async function loadPipe(model: string): Promise<AsrPipe> {
  const repo = whisperRepoFor(model);
  if (!repo) throw new Error(`Unknown Whisper model "${model}".`);
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = modelsDir();
  tf.env.localModelPath = modelsDir();
  if (process.env.AGENTQS_MODELS_OFFLINE === "1") tf.env.allowRemoteModels = false;
  const pipe = await tf.pipeline("automatic-speech-recognition", repo, { dtype: "q8" });
  return pipe as unknown as AsrPipe;
}

function slotFor(model: string): ModelSlot<AsrPipe> {
  let s = slots.get(model);
  if (!s) {
    s = createModelSlot<AsrPipe>({ name: `whisper-${model}`, load: () => loadPipe(model) });
    slots.set(model, s);
  }
  return s;
}

/** Install = load the pipeline once; transformers.js downloads the weights into
 *  data/models on the way (a no-op re-verify when they're already there). */
export async function installWhisperModel(model: string): Promise<void> {
  await slotFor(model).use(async () => undefined);
}

/** Delete a model's weights from data/models (Settings "Remove"). */
export function removeWhisperModel(model: string): void {
  const repo = whisperRepoFor(model);
  if (!repo) return;
  const s = slots.get(model);
  slots.delete(model);
  void s?.release(); // frees as soon as any in-flight transcription returns
  fs.rmSync(path.join(modelsDir(), repo), { recursive: true, force: true });
}

/** Transcribe a WAV recording with an installed model. `lang` is the spoken
 *  language (Whisper token, e.g. "en" / "he") — transformers.js has no
 *  auto-detect yet, so it's a Settings choice defaulting to English. */
export async function transcribeWhisper(audio: Buffer, model: string, lang = "en"): Promise<string> {
  const pcm = decodeWavToMono16k(audio);
  return slotFor(model).use(async (pipe) => {
    const out = await pipe(pcm, { chunk_length_s: 30, stride_length_s: 5, language: lang || "en" });
    const text = Array.isArray(out) ? out.map((o) => o.text ?? "").join(" ") : (out.text ?? "");
    return text.trim();
  });
}

// ---- WAV → Float32 mono 16 kHz ---------------------------------------------

const WAV_HINT =
  "The built-in local Whisper needs WAV audio — the app mic converts automatically; external callers should POST 16 kHz mono WAV.";

/** Parse a WAV buffer (16-bit PCM or 32-bit float, any rate/channels) into the
 *  Float32 mono 16 kHz signal Whisper consumes. Throws a setup-hint error on
 *  anything that isn't WAV, so the memo route surfaces a clear message. */
export function decodeWavToMono16k(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(WAV_HINT);
  }
  let pos = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate) throw new Error(WAV_HINT);

  const { format, channels, sampleRate, bits } = fmt;
  let samples: Float32Array; // interleaved
  if (format === 1 && bits === 16) {
    const n = Math.floor(data.length / 2);
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  } else if (format === 3 && bits === 32) {
    const n = Math.floor(data.length / 4);
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = data.readFloatLE(i * 4);
  } else {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit). ${WAV_HINT}`);
  }

  // Mix down to mono, then resample to Whisper's 16 kHz.
  let mono: Float32Array;
  if (channels === 1) {
    mono = samples;
  } else {
    const frames = Math.floor(samples.length / channels);
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
      mono[i] = sum / channels;
    }
  }
  return resampleLinear(mono, sampleRate, 16000);
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const t = i * ratio;
    const i0 = Math.min(Math.floor(t), input.length - 1);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = t - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
