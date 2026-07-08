/**
 * The local embedding model (Loop 15). Default-on, zero setup, no key, no network,
 * private — it never leaves the machine. It turns a piece of text (a memo, a session
 * synthesis, a query) into a fixed-length unit vector so semantic search can line up
 * two days that *felt* alike even when they don't share the exact words.
 *
 * It's a compact, deterministic featurizer, not a neural net — chosen so embeddings
 * work offline on first run with nothing to download and no dependency to build:
 *
 *   - word features      — every lowercased token (lexical overlap).
 *   - char-trigram features — sub-word shingles, so "sleep" ≈ "sleeping" ≈ "slept"
 *                             and typos still land near the right cluster.
 *   - concept features   — a small hand-built lexicon maps feeling/topic words onto
 *                          shared concept dimensions, so "anxious" and "stressed"
 *                          (or "tired" and "exhausted") pull toward the same axis
 *                          even with zero character overlap. This is what makes
 *                          "find days that felt like this" behave semantically.
 *
 * Features are hashed into a fixed dimension (signed feature hashing), TF-weighted
 * sub-linearly, then L2-normalised so cosine similarity = a dot product. It's pure
 * (no fs, no deps) and byte-deterministic, so the index rebuilds identically.
 *
 * Pluggable by design: `EMBED_MODEL_ID` versions the vector space, and a higher-
 * fidelity neural / API embedder can drop in behind the same `embed()` signature
 * (bump the id to force a reindex). SQL + FTS5 still cover exact/structured recall;
 * this covers "vibe".
 */

export const EMBED_DIM = 256;
export const EMBED_MODEL_ID = "agentqs-local-hash-v1";

/** Concept lexicon: word → concept axes. A word can belong to several. Kept small
 *  and legible on purpose — this is the semantic glue, not a thesaurus. */
const CONCEPTS: Record<string, string[]> = {
  // rest / fatigue
  tired: ["rest"], exhausted: ["rest"], sleep: ["rest"], slept: ["rest"], sleepy: ["rest"],
  rest: ["rest"], rested: ["rest"], nap: ["rest"], insomnia: ["rest"], awake: ["rest"],
  drowsy: ["rest"], groggy: ["rest"], fatigue: ["rest"], fatigued: ["rest"], wired: ["stress"],
  restless: ["rest", "stress"], drained: ["rest", "low"], knackered: ["rest"], burnt: ["rest", "low"], burnout: ["rest", "low"],
  wiped: ["rest"], beat: ["rest"], spent: ["rest"], wrecked: ["rest"], shattered: ["rest"], zombie: ["rest"],
  // stress / anxiety
  anxious: ["stress"], anxiety: ["stress"], stress: ["stress"], stressed: ["stress"], overwhelmed: ["stress"],
  worried: ["stress"], worry: ["stress"], panic: ["stress"], tense: ["stress"], nervous: ["stress"],
  pressure: ["stress"], dread: ["stress", "low"], racing: ["stress"], frazzled: ["stress"], edgy: ["stress"],
  // low mood
  sad: ["low"], down: ["low"], low: ["low"], depressed: ["low"], empty: ["low"],
  numb: ["low"], unmotivated: ["low"], flat: ["low"], hopeless: ["low"], lonely: ["low", "social"],
  crying: ["low"], cried: ["low"], miserable: ["low"], heavy: ["low"], stuck: ["low"],
  // high mood / calm
  happy: ["good"], great: ["good"], good: ["good"], joy: ["good"], joyful: ["good"],
  excited: ["good"], elated: ["good"], grateful: ["good"], calm: ["good", "calm"], content: ["good", "calm"],
  peaceful: ["calm"], relaxed: ["calm"], serene: ["calm"], energized: ["good", "energy"], energetic: ["energy"],
  clear: ["calm", "focus"], light: ["good"], alive: ["good", "energy"], proud: ["good"], hopeful: ["good"],
  wonderful: ["good"], amazing: ["good"], fantastic: ["good"], awesome: ["good"], brilliant: ["good"],
  lovely: ["good"], terrific: ["good"], delighted: ["good"], cheerful: ["good"], upbeat: ["good", "energy"],
  energy: ["energy"], energised: ["good", "energy"], vibrant: ["energy", "good"], buzzing: ["energy", "good"],
  pumped: ["energy", "good"], motivated: ["energy", "focus"], refreshed: ["energy", "rest"], fresh: ["energy", "good"],
  // anger
  angry: ["anger"], frustrated: ["anger"], irritated: ["anger"], annoyed: ["anger"], mad: ["anger"],
  rage: ["anger"], resentful: ["anger"], furious: ["anger"], bitter: ["anger", "low"],
  // work / focus
  work: ["work"], working: ["work"], focus: ["focus"], focused: ["focus"], productive: ["work", "focus"],
  deadline: ["work", "stress"], shipped: ["work"], coding: ["work"], meeting: ["work"], meetings: ["work"],
  busy: ["work"], distracted: ["focus"], deep: ["focus"], grind: ["work"], flow: ["focus", "good"],
  // social
  friends: ["social"], friend: ["social"], family: ["social"], alone: ["social"], connection: ["social"],
  talked: ["social"], party: ["social"], together: ["social"], date: ["social", "love"], call: ["social"],
  // body / health
  sick: ["health"], ill: ["health"], headache: ["health"], pain: ["health"], sore: ["health"],
  workout: ["health", "energy"], run: ["health", "energy"], gym: ["health", "energy"], exercise: ["health", "energy"], hungover: ["health", "low"],
  // love / relationship
  love: ["love"], partner: ["love"], relationship: ["love"], breakup: ["love", "low"], fight: ["love", "anger"],
  miss: ["love", "low"], kiss: ["love"], heartbroken: ["love", "low"],
};

const CONCEPT_WEIGHT = 2.2; // concept axes count for more than a raw word
const TRIGRAM_WEIGHT = 0.5;

/** FNV-1a 32-bit hash of a string — stable across runs/machines. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** Split into lowercased alphanumeric word tokens (unicode-aware). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 0);
}

/** Signed feature hashing: add a weighted feature into the accumulator. The low bit
 *  of a second hash picks the sign, which de-biases collisions. */
function addFeature(acc: Float64Array, feature: string, weight: number): void {
  const h = fnv1a(feature);
  const dim = h % EMBED_DIM;
  const sign = (fnv1a("s:" + feature) & 1) === 0 ? 1 : -1;
  acc[dim] += weight * sign;
}

/**
 * Embed text into a unit vector (Float32Array of length EMBED_DIM). Empty / wordless
 * text yields a zero vector (callers skip those). Deterministic and allocation-cheap.
 */
export function embed(text: string): Float32Array {
  const acc = new Float64Array(EMBED_DIM);
  const words = tokenize(text);
  if (words.length === 0) return new Float32Array(EMBED_DIM);

  // Sub-linear term frequency so a repeated word doesn't dominate.
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);

  for (const [word, n] of counts) {
    const tf = 1 + Math.log(n);
    addFeature(acc, "w:" + word, tf);

    // char trigrams of the padded word (captures morphology + typos)
    const padded = `^${word}$`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      addFeature(acc, "t:" + padded.slice(i, i + 3), tf * TRIGRAM_WEIGHT);
    }

    for (const concept of CONCEPTS[word] ?? []) {
      addFeature(acc, "c:" + concept, tf * CONCEPT_WEIGHT);
    }
  }

  // L2-normalise → cosine similarity becomes a plain dot product.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += acc[i] * acc[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(EMBED_DIM);
  if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) out[i] = acc[i] / norm;
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
