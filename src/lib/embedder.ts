import path from "path";
import { dataDir } from "./paths";
import { embed as hashEmbed, EMBED_DIM as HASH_DIM, EMBED_MODEL_ID as HASH_ID } from "./embed";

/**
 * The local text embedder (Batch C). Default-on, no key, no cost, private — turns a
 * memo / session synthesis / query into a unit vector so "find days that felt like
 * this" matches by MEANING.
 *
 * Two backends behind one async API, chosen at runtime:
 *   - neural (default): a real sentence-transformer (multilingual-e5-small) run
 *     locally via transformers.js + onnxruntime (CoreML on Mac). The quantized model
 *     ships under data/models and loads in ~90ms; 384-dim, genuine semantic similarity.
 *   - hash fallback: the pure-JS featurizer in embed.ts (256-dim). Used only when the
 *     neural model can't load (never downloaded + offline, or an exotic host), so the
 *     feature never hard-fails.
 *
 * THE MODEL MUST BE MULTILINGUAL. It was all-MiniLM-L6-v2, which is ENGLISH-ONLY, so
 * every Hebrew memo, dream and journal note in the record was unreachable by any query
 * in any language — recall was silently half-blind on a record that is largely Hebrew.
 * A hit on Hebrew text only ever came from the English `source.metric:` prefix we
 * prepend, never from the words themselves. Keep any replacement multilingual.
 *
 * E5 is trained with ASYMMETRIC prefixes: a stored document must be embedded as
 * "passage: …" and a search string as "query: …". Embedding both the same way costs
 * real accuracy, so `embed` takes the role and the two call sites (buildIndex →
 * passage, semanticSearch → query) pass it. The hash fallback ignores the role.
 *
 * The chosen backend's `id` versions the vector space and its `dim` sizes the
 * sqlite-vec table, so switching backends (or bumping the model) forces a clean
 * reindex via the staleness check in embeddings.ts. The model is loaded once and
 * cached for the process.
 */

/** A stored document ("passage") or a search string ("query") — E5 scores them
 *  against each other only when each carries its own prefix. */
export type EmbedRole = "passage" | "query";

export interface TextEmbedder {
  id: string;
  dim: number;
  embed(texts: string[], role?: EmbedRole): Promise<Float32Array[]>;
}

const NEURAL_MODEL = "Xenova/multilingual-e5-small";
const NEURAL_ID = "e5-small-multilingual-q8";
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

/** E5's asymmetric prefixes. A passage and a query are embedded into the same space
 *  only when each is tagged; an untagged pair scores measurably worse. */
function withRole(texts: string[], role: EmbedRole): string[] {
  return texts.map((t) => `${role}: ${t}`);
}

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
      async embed(texts, role: EmbedRole = "passage") {
        if (texts.length === 0) return [];
        const tagged = withRole(texts, role);
        const res: Float32Array[] = [];
        const batchSize = Number(process.env.AGENTQS_EMBED_BATCH || 32);
        for (let start = 0; start < tagged.length; start += batchSize) {
          // truncation: the model's window is finite, so anything longer is CLIPPED
          // here. Callers must chunk long text (embeddings.ts) or the tail of a long
          // document is never embedded at all.
          const out = await pipe(tagged.slice(start, start + batchSize), {
            pooling: "mean",
            normalize: true,
          });
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
