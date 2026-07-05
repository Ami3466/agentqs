/**
 * First-run tour plumbing — one place for the step ids, the "a real action just
 * happened" event, the chat pre-fill hand-off, and the local progress cache.
 * The OnboardingTour (global chrome) listens; the real actions emit. Framework-
 * free + window-guarded, so any client component can import it safely.
 */

export type TourStep = "source" | "chat" | "memo";

/** A real action completed somewhere in the app — the mounted tour re-checks. */
export const TOUR_STEP_EVENT = "agentqs:tour-step";

/** The tour's suggested input, handed to Chat (a grounded question, or `>>` to
 *  show the memo path). Chat reads it live via the event and on mount via the key. */
export const CHAT_PREFILL_EVENT = "agentqs:chat-prefill";
export const CHAT_PREFILL_KEY = "agentqs.chat.prefill";

/** Local cache of which steps are done, so a hard reload mid-tour keeps the
 *  checks. Source is always re-confirmed from the server regardless. */
export const TOUR_PROGRESS_KEY = "agentqs.tour.progress";

/** Tell a mounted tour that a real action just happened (a source connected, a
 *  chat sent, a memo saved). Safe to call from anywhere on the client. */
export function markTourStep(step: TourStep): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TourStep>(TOUR_STEP_EVENT, { detail: step }));
}

/** Stash the tour's suggested chat input and nudge a mounted Chat to load it. */
export function primeChatPrefill(text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_PREFILL_KEY, text);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<string>(CHAT_PREFILL_EVENT, { detail: text }));
}

/** Read + clear the stashed chat input (used by Chat on mount). */
export function takeChatPrefill(): string {
  if (typeof window === "undefined") return "";
  try {
    const v = window.localStorage.getItem(CHAT_PREFILL_KEY);
    if (v) window.localStorage.removeItem(CHAT_PREFILL_KEY);
    return v || "";
  } catch {
    return "";
  }
}
