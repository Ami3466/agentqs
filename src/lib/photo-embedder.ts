import { modelsDir } from "./embedder";

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

async function loadClip(): Promise<ImageEmbedder | null> {
  try {
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
      id: CLIP_ID,
      dim: CLIP_DIM,
      async embedImage(filePath: string) {
        try {
          const image = await tf.RawImage.read(filePath);
          const inputs = await processor(image);
          const { image_embeds } = await visionModel(inputs);
          return l2normalize(Float32Array.from(image_embeds.data as Float32Array));
        } catch {
          return null;
        }
      },
      async embedText(text: string) {
        const t = text.trim();
        if (!t) return null;
        const inputs = tokenizer([t], { padding: true, truncation: true });
        const { text_embeds } = await textModel(inputs);
        return l2normalize(Float32Array.from(text_embeds.data as Float32Array));
      },
    };
  } catch {
    return null;
  }
}

let cached: Promise<ImageEmbedder | null> | null = null;

/** The active CLIP embedder, or null if the model/library isn't available. Loaded once. */
export function getImageEmbedder(): Promise<ImageEmbedder | null> {
  if (process.env.AGENTQS_PHOTO_EMBED === "off") return Promise.resolve(null);
  if (!cached) cached = loadClip();
  return cached;
}
