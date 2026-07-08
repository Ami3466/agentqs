import path from "path";
import { dataDir } from "./paths";
import { embed as hashEmbed, EMBED_DIM as HASH_DIM, EMBED_MODEL_ID as HASH_ID } from "./embed";

/**
 * The local text embedder (Batch C). Default-on, no key, no cost, private — turns a
 * memo / session synthesis / query into a unit vector so "find days that felt like
 * this" matches by MEANING.
 *
 * Two backends behind one async API, chosen at runtime:
 *   - neural (default): a real sentence-transformer (all-MiniLM-L6-v2) run locally
 *     via transformers.js + onnxruntime (CoreML on Mac). The quantized model ships
 *     under data/models and loads in ~90ms; 384-dim, genuine semantic similarity.
 *   - hash fallback: the pure-JS featurizer in embed.ts (256-dim). Used only when the
 *     neural model can't load (never downloaded + offline, or an exotic host), so the
 *     feature never hard-fails.
 *
 * The chosen backend's `id` versions the vector space and its `dim` sizes the
 * sqlite-vec table, so switching backends (or bumping the model) forces a clean
 * reindex via the staleness check in embeddings.ts. The model is loaded once and
 * cached for the process.
 */

export interface TextEmbedder {
  id: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const NEURAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const NEURAL_ID = "minilm-l6-v2-q8";
const NEURAL_DIM = 384;

/** Where transformers.js caches / reads model weights — under the data dir so they
 *  persist and stay off the network after the first fetch. */
export function modelsDir(): string {
  return process.env.AGENTQS_MODELS_DIR || path.join(dataDir(), "models");
}

const hashEmbedder: TextEmbedder = {
  id: HASH_ID,
  dim: HASH_DIM,
  async embed(texts) {
    return texts.map(hashEmbed);
  },
};

/** Try to load the neural sentence-transformer. Returns null (→ hash fallback) if the
 *  library or the model isn't available (e.g. never downloaded and offline). */
async function loadNeural(): Promise<TextEmbedder | null> {
  if (process.env.AGENTQS_EMBED_BACKEND === "hash") return null;
  try {
    const tf = await import("@huggingface/transformers");
    tf.env.cacheDir = modelsDir();
    tf.env.localModelPath = modelsDir();
    if (process.env.AGENTQS_MODELS_OFFLINE === "1") tf.env.allowRemoteModels = false;
    const pipe = await tf.pipeline("feature-extraction", NEURAL_MODEL, { dtype: "q8" });
    return {
      id: NEURAL_ID,
      dim: NEURAL_DIM,
      async embed(texts) {
        if (texts.length === 0) return [];
        const res: Float32Array[] = [];
        const batchSize = Number(process.env.AGENTQS_EMBED_BATCH || 32);
        for (let start = 0; start < texts.length; start += batchSize) {
          const out = await pipe(texts.slice(start, start + batchSize), { pooling: "mean", normalize: true });
          const [n, d] = out.dims as [number, number];
          const data = out.data as Float32Array;
          for (let i = 0; i < n; i++) res.push(Float32Array.from(data.subarray(i * d, i * d + d)));
        }
        return res;
      },
    };
  } catch {
    return null;
  }
}

let cached: Promise<TextEmbedder> | null = null;

/** The active text embedder — neural when available, hash otherwise. Loaded once. */
export function getTextEmbedder(): Promise<TextEmbedder> {
  if (!cached) cached = loadNeural().then((n) => n ?? hashEmbedder);
  return cached;
}

/** Reset the cached embedder (tests only). */
export function _resetEmbedder(): void {
  cached = null;
}
