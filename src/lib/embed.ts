/**
 * The local embedding model (Loop 15, upgraded). Default-on, zero setup, no API key,
 * private — vectors never leave the machine. It turns a piece of text (a memo, a
 * session synthesis, a query) into a fixed-length unit vector so semantic search can
 * line up two days that *felt* alike even when they don't share a single word.
 *
 * This is a REAL sentence-transformer — all-MiniLM-L6-v2 running locally through
 * transformers.js on the ONNX runtime — not the old bag-of-words featurizer. It
 * understands meaning ("the deploy finally went out and I could breathe" lands near
 * "shipped, huge relief" with no shared words and no hand-built lexicon), which the
 * hash shim could never do.
 *
 * Offline after first run: the quantized model (~23 MB) downloads once into the data
 * dir (AGENTQS_MODEL_DIR, default <data>/models) and every run after reads it from
 * that cache with no network. The runtime is loaded lazily so nothing is paid until
 * the first embed, and the pipeline is memoised for the process.
 *
 * Pluggable by design: `EMBED_MODEL_ID` versions the vector space — bump it to force
 * a reindex when the model changes. SQL + FTS5 still cover exact/structured recall;
 * this covers "vibe".
 */
import path from "path";
import { dataDir } from "./paths";

/** all-MiniLM-L6-v2 emits 384-dim sentence embeddings. */
export const EMBED_DIM = 384;
/** The real model id. Stamped into the index; a change here forces a reindex. */
export const EMBED_MODEL_ID = "all-MiniLM-L6-v2";
/** transformers.js hub repo for the ONNX weights. */
const EMBED_MODEL_REPO = "Xenova/all-MiniLM-L6-v2";

/** Where the model weights are cached. Defaults to the data dir so the whole app
 *  (config, record, cache, model) lives under one folder; override with
 *  AGENTQS_MODEL_DIR to share a warm cache across instances. */
function modelCacheDir(): string {
  return process.env.AGENTQS_MODEL_DIR || path.join(dataDir(), "models");
}

type FeatureTensor = { data: ArrayLike<number> };
type Extractor = (
  text: string,
  opts: { pooling: "mean" | "cls" | "none"; normalize: boolean },
) => Promise<FeatureTensor>;

let extractorPromise: Promise<Extractor> | null = null;

/** Load (once) the local feature-extraction pipeline, caching the weights in the data
 *  dir. Dynamically imported so transformers.js / onnxruntime are only touched
 *  server-side and only when embeddings are actually used. */
async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      // Cache the downloaded model in the data dir; read from there offline after run 1.
      env.cacheDir = modelCacheDir();
      env.allowRemoteModels = true; // download once on first run, then serve from cache
      const pipe = await pipeline("feature-extraction", EMBED_MODEL_REPO, { quantized: true });
      return pipe as unknown as Extractor;
    })();
  }
  return extractorPromise;
}

function toVec(t: FeatureTensor): Float32Array {
  return Float32Array.from(t.data as ArrayLike<number>);
}

/**
 * Embed text into a unit vector (Float32Array of length EMBED_DIM). Empty / wordless
 * text yields a zero vector (callers skip those). Mean-pooled + L2-normalised, so
 * cosine similarity is a plain dot product. Async: the model runs off the main sync
 * path (and the first call may download the weights).
 */
export async function embed(text: string): Promise<Float32Array> {
  const t = text.trim();
  if (!t) return new Float32Array(EMBED_DIM);
  const extractor = await getExtractor();
  return toVec(await extractor(t, { pooling: "mean", normalize: true }));
}

/** Embed many texts, reusing the one loaded pipeline. Empty strings map to zero
 *  vectors so positions line up with the input. Used by the index builder, which
 *  must compute every vector BEFORE opening its (synchronous) SQLite transaction. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const extractor = await getExtractor();
  const out: Float32Array[] = [];
  for (const text of texts) {
    const t = text.trim();
    if (!t) {
      out.push(new Float32Array(EMBED_DIM));
      continue;
    }
    out.push(toVec(await extractor(t, { pooling: "mean", normalize: true })));
  }
  return out;
}

/** Pack a vector into the little-endian float32 BLOB sqlite-vec (and the JS
 *  fallback) store. */
export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Read a stored float32 BLOB back into a vector (JS fallback cosine path). Reads
 *  element-wise so a Buffer with a non-4-aligned pool offset can't throw. */
export function blobToVector(buf: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(buf.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity of two unit vectors = their dot product. Used by the pure-JS
 *  search fallback and the ships-when proof. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
