import { modelsDir } from "./embedder";
import { createModelSlot } from "./model-slot";

/**
 * The local CLIP image/text embedder (Batch C · Photos). Runs entirely on-device via
 * transformers.js + onnxruntime (CoreML on Mac). CLIP maps a photo and a text phrase
 * into the SAME 512-dim space, so a natural-language query ("beach at sunset", "my
 * dog") can recall the matching photos with no labels and no key — the "text→image
 * recall" from the plan.
 *
 * Two towers, one space:
 *   - vision: AutoProcessor + CLIPVisionModelWithProjection → image_embeds
 *   - text:   AutoTokenizer  + CLIPTextModelWithProjection  → text_embeds
 * Both are L2-normalised here, so cosine similarity is a plain dot product. The
 * quantized weights live under data/models (fetched once, then offline). If the model
 * or library can't load, the embedder is null and the caller degrades gracefully
 * (EXIF + thumbnails still work; only semantic recall is skipped).
 *
 * The towers live in a model-slot, so importing one batch of photos no longer raises
 * the process floor for good: they are disposed after AGENTQS_MODEL_IDLE_MS idle and
 * reloaded on the next embed. Whether CLIP is AVAILABLE is probed once and remembered,
 * and `id`/`dim` are constants — the vector space must not shift under a built index
 * just because the model was evicted between two imports.
 */

export const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
export const CLIP_ID = "clip-vit-base-patch32-q8";
export const CLIP_DIM = 512;

export interface ImageEmbedder {
  id: string;
  dim: number;
  embedImage(filePath: string): Promise<Float32Array | null>;
  embedText(text: string): Promise<Float32Array | null>;
}

function l2normalize(a: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] * a[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < a.length; i++) a[i] /= n;
  return a;
}

/** The two loaded towers. `dispose` frees BOTH onnx sessions — dropping one and
 *  leaking the other would leave half the memory parked, which is the whole point. */
interface ClipTowers {
  embedImage(filePath: string): Promise<Float32Array | null>;
  embedText(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

/** Load both CLIP towers. THROWS when the library or the weights aren't available
 *  (never downloaded and offline, exotic host) — the slot leaves itself cold and
 *  getImageEmbedder() reports null, so callers degrade instead of failing. */
async function loadClip(): Promise<ClipTowers> {
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = modelsDir();
  tf.env.localModelPath = modelsDir();
  if (process.env.AGENTQS_MODELS_OFFLINE === "1") tf.env.allowRemoteModels = false;

  const [tokenizer, textModel, processor, visionModel] = await Promise.all([
    tf.AutoTokenizer.from_pretrained(CLIP_MODEL),
    tf.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: "q8" }),
    tf.AutoProcessor.from_pretrained(CLIP_MODEL),
    tf.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: "q8" }),
  ]);

  return {
    async embedImage(filePath: string) {
      try {
        const image = await tf.RawImage.read(filePath);
        const inputs = await processor(image);
        const { image_embeds } = await visionModel(inputs);
        return l2normalize(Float32Array.from(image_embeds.data as Float32Array));
      } catch {
        return null; // an unreadable/odd file skips its vector, it does not fail the import
      }
    },
    async embedText(text: string) {
      const inputs = tokenizer([text], { padding: true, truncation: true });
      const { text_embeds } = await textModel(inputs);
      return l2normalize(Float32Array.from(text_embeds.data as Float32Array));
    },
    async dispose() {
      await Promise.allSettled([textModel.dispose(), visionModel.dispose()]);
    },
  };
}

/** The towers' home: warm while photos are being embedded, disposed after the idle TTL. */
const clipSlot = createModelSlot<ClipTowers>({ name: "clip-image-embedder", load: loadClip });

/** A stable facade over the slot: `id`/`dim` are fixed, and each call borrows the
 *  towers for exactly its own duration, so an eviction can never land mid-embed. */
const imageEmbedder: ImageEmbedder = {
  id: CLIP_ID,
  dim: CLIP_DIM,
  async embedImage(filePath: string) {
    try {
      return await clipSlot.use((clip) => clip.embedImage(filePath));
    } catch {
      return null; // a reload that can't find the weights degrades, it doesn't throw
    }
  },
  async embedText(text: string) {
    const t = text.trim();
    if (!t) return null; // never wake the model for an empty query
    try {
      return await clipSlot.use((clip) => clip.embedText(t));
    } catch {
      return null;
    }
  },
};

let cached: Promise<ImageEmbedder | null> | null = null;

/** The active CLIP embedder, or null if the model/library isn't available. Probed once. */
export function getImageEmbedder(): Promise<ImageEmbedder | null> {
  if (process.env.AGENTQS_PHOTO_EMBED === "off") return Promise.resolve(null);
  if (!cached) {
    cached = clipSlot
      .use(async () => imageEmbedder)
      .catch(() => null); // no library / no weights → callers skip semantic recall
  }
  return cached;
}

/** Drop any warm CLIP towers and the availability probe (tests only). */
export function _resetImageEmbedder(): void {
  cached = null;
  void clipSlot.release();
}
