/**
 * A TTL-evicted slot for ONE heavy local model.
 *
 * Every transformers.js pipeline we load (the text embedder, the image captioner,
 * CLIP for photo search, each Whisper size) costs hundreds of MB of mostly NATIVE
 * onnxruntime memory, and
 * each one used to be parked in a module-level promise for the life of the process.
 * RSS was therefore a high-water mark: caption a single photo and the server floor
 * stayed higher until restart, even though the model was never touched again.
 *
 * This slot keeps the "load once, reuse while warm" behaviour that makes back-to-back
 * calls fast, and adds the missing half — after the slot has sat IDLE for a TTL it
 * disposes the pipeline and drops the reference, so the next call reloads. Idle memory
 * goes back to the floor; busy memory is unchanged.
 *
 * The one way this can crash production is disposing a pipeline out from under a call
 * in progress, so use is REFCOUNTED. `use()` increments synchronously before it awaits
 * anything, decrements in a `finally`, and eviction only ever runs at refcount 0 —
 * a pipeline a caller is holding is never disposable. The idle timer is `unref()`ed so
 * a warm slot can never keep the CLI (or any short-lived process) alive.
 *
 * Loading stays LAZY: nothing here loads at import or at boot, only on first use.
 *
 * Env: AGENTQS_MODEL_IDLE_MS sets the TTL (default 5 min; 0 = evict the moment the
 * last caller leaves). AGENTQS_MODEL_DEBUG=1 logs each eviction with the RSS after it,
 * which is how you check on a real host that idle memory is actually coming back.
 */

/** How long a slot may sit unused before its model is disposed. Read per-schedule
 *  (not at import) so a process can tune it, and tests can drive it to milliseconds. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export function modelIdleMs(): number {
  const raw = Number(process.env.AGENTQS_MODEL_IDLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_MS;
}

export interface ModelSlot<T> {
  /** Borrow the model for the duration of `fn`. Loads it if cold, holds a reference
   *  for the whole call, and starts the idle countdown when the last caller leaves. */
  use<R>(fn: (model: T) => Promise<R>): Promise<R>;
  /** Drop the model now (or as soon as the last in-flight caller returns). Used by
   *  "remove this model" flows and by tests. Never disposes under a live caller. */
  release(): Promise<void>;
  /** Introspection for tests/diagnostics — never a correctness signal for callers. */
  stats(): { loaded: boolean; refs: number; loads: number; disposes: number };
}

/**
 * Dispose a loaded model. transformers.js pipelines expose an async `dispose()` which
 * frees the onnxruntime sessions — that is the call that actually returns the native
 * memory. Anything WITHOUT a `dispose` is simply dereferenced and left to the GC; we
 * do not invent a teardown for objects that never published one.
 */
async function disposeModel(model: unknown): Promise<void> {
  const d = (model as { dispose?: () => unknown } | null)?.dispose;
  if (typeof d !== "function") return;
  await (d as () => unknown).call(model);
}

export interface ModelSlotOptions<T> {
  /** Label used in the eviction warning — e.g. "text-embedder". */
  name: string;
  /** Loads the model. Called only on demand, and again after an eviction. */
  load: () => Promise<T>;
  /** Override the idle TTL for this slot (defaults to AGENTQS_MODEL_IDLE_MS). */
  idleMs?: () => number;
}

export function createModelSlot<T>(opts: ModelSlotOptions<T>): ModelSlot<T> {
  let loading: Promise<T> | null = null; // the CURRENT generation's load, null when cold
  let refs = 0; // callers inside use() right now — eviction is forbidden while > 0
  let timer: ReturnType<typeof setTimeout> | null = null;
  let releasePending = false; // release() called while a caller was still holding it
  let loads = 0;
  let disposes = 0;

  const idle = () => (opts.idleMs ? opts.idleMs() : modelIdleMs());

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** Take the current generation away from future callers and dispose it. Only ever
   *  called at refcount 0, so nothing is holding the model it drops. */
  async function evict(): Promise<void> {
    if (refs > 0) return; // someone grabbed it between the timer firing and now
    const dying = loading;
    loading = null; // ← atomic hand-off: a new use() starts a FRESH load from here on
    releasePending = false;
    if (!dying) return;
    disposes++;
    let model: T;
    try {
      model = await dying;
    } catch {
      return; // a load that never succeeded has nothing to free
    }
    try {
      await disposeModel(model);
      if (process.env.AGENTQS_MODEL_DEBUG === "1") {
        console.warn(`[agentqs] model slot "${opts.name}" evicted after idle · rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
      }
    } catch {
      // A pipeline that refuses to dispose still gets dereferenced — the GC is the
      // backstop. Swallowing here keeps an idle timer from crashing the process.
    }
  }

  function scheduleEvict(): void {
    clearTimer();
    if (releasePending) {
      void evict();
      return;
    }
    const ms = idle();
    if (ms === 0) {
      void evict();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void evict();
    }, ms);
    // NEVER let a warm model hold the event loop open: without this the CLI finishes
    // its command and then hangs for the whole TTL instead of exiting.
    (timer as { unref?: () => void }).unref?.();
  }

  async function use<R>(fn: (model: T) => Promise<R>): Promise<R> {
    // Synchronous, BEFORE any await: from this line on the slot cannot be evicted.
    refs++;
    clearTimer();
    try {
      let current = loading;
      if (!current) {
        loads++;
        current = opts.load();
        loading = current;
      }
      const mine = current;
      let model: T;
      try {
        model = await mine;
      } catch (err) {
        if (loading === mine) loading = null; // a failed load is not cached — retry next call
        throw err;
      }
      return await fn(model);
    } finally {
      refs--;
      if (refs === 0) scheduleEvict();
    }
  }

  async function release(): Promise<void> {
    clearTimer();
    if (refs > 0) {
      releasePending = true; // the last caller out will evict immediately
      return;
    }
    await evict();
  }

  return {
    use,
    release,
    stats: () => ({ loaded: loading !== null, refs, loads, disposes }),
  };
}
