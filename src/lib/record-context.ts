import { AsyncLocalStorage } from "async_hooks";

/**
 * THE EXECUTION-CONTEXT BOUNDARY between a request and a converger.
 *
 * What happened, and why a comment was not enough: structuring five pending inbox
 * items through `POST /api/structure` froze every request on the instance for over
 * fifteen minutes. `/api/doctor` timed out; even `GET /` took 14s to answer a
 * redirect. Nothing was broken — a user pressed a button, and a code path under it
 * reached `rebuild()`, which re-reads the entire record (660MB of events.jsonl) and
 * re-indexes every event. better-sqlite3 is SYNCHRONOUS, so that work owns the Node
 * thread outright: every other request, every poll, every health check queues behind
 * it and the app reads as crashed.
 *
 * The rule "never call rebuild() from a request" was already written down. It was
 * still broken, because half a dozen `land*` helpers quietly fell back to a rebuild
 * whenever their patch reported it could not apply — the fallback was invisible at
 * the call site. So the rule is enforced here instead of documented:
 *
 *   • `rebuild()` calls `assertConverger()` and THROWS outside a converger context.
 *   • A converger context is opened only at the true converger entry points:
 *     `agentqs rebuild`, the CLI's own sync paths, the in-process scheduler sweep,
 *     the record-replacing restore, and the test scripts.
 *   • Everything a request can reach must land its change instead
 *     (`landDailySources` / `landInboxCaptures` / `landSessionWrite` / …), and when
 *     a patch genuinely cannot apply it fails LOUDLY rather than re-deriving the
 *     record under an HTTP handler.
 *
 * The default is derived from where the code is running, so a plain `node`/`tsx`
 * process (the CLI, every script, the daemon) is a converger with no ceremony,
 * while ANY code inside the Next.js server starts outside one. `NEXT_RUNTIME` is
 * set by Next itself in the server bundle — `src/instrumentation.ts` already keys
 * off it — so the web server cannot forget to opt in.
 */

/** Explicit context for the current async flow. Absent → the process default. */
const store = new AsyncLocalStorage<boolean>();

/** True inside the Next.js server runtime (route handlers, server components, the
 *  instrumentation hook). Read live, never cached: a test can set it to reproduce
 *  the production request path exactly. */
function insideWebServer(): boolean {
  return process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge";
}

/** Is the current flow allowed to re-derive the whole record? */
export function isConverger(): boolean {
  const explicit = store.getStore();
  if (explicit !== undefined) return explicit;
  return !insideWebServer();
}

/** Open a converger context for `fn` — the ONE place a full rebuild is legal.
 *  Nested calls are fine; the context closes when `fn` returns. */
export function runAsConverger<T>(fn: () => T): T {
  return store.run(true, fn);
}

/** The async twin. AsyncLocalStorage carries the context across every `await`
 *  inside `fn`, and across nothing outside it — so a background job started from a
 *  request never inherits one by accident. */
export function runAsConvergerAsync<T>(fn: () => Promise<T>): Promise<T> {
  return store.run(true, fn);
}

/** Run `fn` as a REQUEST would: no rebuild, whatever the process default is. Used
 *  by the freeze guard's tests to drive production code down the request path, and
 *  available to any long-lived worker that wants the same protection. */
export function runAsRequest<T>(fn: () => T): T {
  return store.run(false, fn);
}

/** The message a request gets when it reaches a full rebuild. It names the fix,
 *  because "rebuild is not allowed here" without the alternative is how the
 *  fallbacks got written in the first place. */
export const REBUILD_IN_REQUEST =
  "rebuild() is a converger, not a request path — it re-reads the whole record. " +
  "Land the change instead (landDailySources / landInboxCaptures / …), or run `agentqs rebuild`.";

/** Guard at the top of `rebuild()`. Throws outside a converger context. */
export function assertConverger(): void {
  if (!isConverger()) throw new Error(REBUILD_IN_REQUEST);
}
