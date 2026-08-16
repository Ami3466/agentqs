import { modelsDir } from "./embedder";
import { createModelSlot } from "./model-slot";

/**
 * Optional local image captioning (Batch C · Photos, tier ③). A small on-device model
 * (vit-gpt2, in the moondream/BLIP family) describes a photo in a sentence; that
 * sentence is distilled into a handful of scene tags that roll up into daily columns
 * (scene_outdoor, scene_food, …) so the mentor can correlate "days with people/nature
 * photos" against mood and sleep. No key, runs locally, gated behind `--caption`.
 * Returns null gracefully if the model/library can't load — EXIF, thumbnails and CLIP
 * recall still work without it.
 *
 * The pipeline lives in a model-slot, so captioning one photo no longer raises the
 * process floor for good: it is disposed after AGENTQS_MODEL_IDLE_MS idle and reloaded
 * on the next caption. Whether the model is AVAILABLE is probed once and remembered.
 */

export const CAPTION_MODEL = "Xenova/vit-gpt2-image-captioning";

export interface Captioner {
  caption(filePath: string): Promise<string | null>;
}

type CaptionPipe = (
  filePath: string,
  opts: { max_new_tokens: number },
) => Promise<{ generated_text?: string }[]>;

async function loadCaptionPipe(): Promise<CaptionPipe> {
  const tf = await import("@huggingface/transformers");
  tf.env.cacheDir = modelsDir();
  tf.env.localModelPath = modelsDir();
  if (process.env.AGENTQS_MODELS_OFFLINE === "1") tf.env.allowRemoteModels = false;
  const pipe = await tf.pipeline("image-to-text", CAPTION_MODEL, { dtype: "q8" });
  return pipe as unknown as CaptionPipe;
}

const captionSlot = createModelSlot<CaptionPipe>({ name: "captioner", load: loadCaptionPipe });

const captioner: Captioner = {
  async caption(filePath: string) {
    try {
      return await captionSlot.use(async (pipe) => {
        const out = await pipe(filePath, { max_new_tokens: 24 });
        const text = out?.[0]?.generated_text?.trim();
        return text ? text.replace(/\s+/g, " ") : null;
      });
    } catch {
      return null;
    }
  },
};

let cached: Promise<Captioner | null> | null = null;

export function getCaptioner(): Promise<Captioner | null> {
  if (!cached) {
    cached = captionSlot
      .use(async () => captioner)
      .catch(() => null); // no library / no weights → callers skip captioning
  }
  return cached;
}

/** Drop any warm caption pipeline and the availability probe (tests only). */
export function _resetCaptioner(): void {
  cached = null;
  void captionSlot.release();
}

// ---- Caption → scene tags -------------------------------------------------

/** A small, legible scene lexicon: caption keyword → tag. Kept intentionally short —
 *  it's a coarse rollup for correlation, not an object detector. */
const SCENE_LEXICON: Record<string, string[]> = {
  people: ["person", "people", "man", "woman", "men", "women", "child", "kid", "crowd", "group", "family", "friends", "boy", "girl"],
  food: ["food", "meal", "plate", "pizza", "coffee", "drink", "restaurant", "cake", "dinner", "lunch", "breakfast", "table"],
  nature: ["tree", "trees", "mountain", "forest", "field", "flower", "flowers", "grass", "lake", "river", "sky", "sunset", "garden", "hill"],
  beach: ["beach", "ocean", "sea", "sand", "surf", "wave", "waves", "coast"],
  city: ["city", "street", "building", "buildings", "car", "cars", "road", "urban", "traffic", "downtown"],
  indoor: ["room", "kitchen", "desk", "couch", "bed", "office", "indoor", "wall"],
  animal: ["dog", "cat", "bird", "horse", "animal", "pet"],
  screen: ["screen", "laptop", "computer", "phone", "monitor", "whiteboard", "text"],
  water: ["water", "pool", "boat"],
  night: ["night", "dark", "lights"],
};

/** Distil a caption into scene tags (deduped, stable order). */
export function captionToTags(caption: string): string[] {
  const words = new Set(caption.toLowerCase().match(/[a-z]+/g) ?? []);
  const tags: string[] = [];
  for (const [tag, keys] of Object.entries(SCENE_LEXICON)) {
    if (keys.some((k) => words.has(k))) tags.push(tag);
  }
  return tags;
}
