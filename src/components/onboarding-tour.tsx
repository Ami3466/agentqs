"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "@/components/icons";
import { cn } from "@/components/ui";
import {
  TOUR_PROGRESS_KEY,
  TOUR_STEP_EVENT,
  primeChatPrefill,
  type TourStep,
} from "@/lib/tour";

type Progress = Record<TourStep, boolean>;
const EMPTY: Progress = { source: false, chat: false, memo: false };

/** The tour's suggested grounded question — matches the Chat empty-state prompt. */
const SUGGESTED_QUESTION = "Why have I felt off this week?";

interface Step {
  id: TourStep;
  label: string; // one line, wpbot-tight
  cta: string;
  run: (go: (href: string) => void) => void;
}

const STEPS: Step[] = [
  {
    id: "source",
    label: "Connect a data source",
    cta: "Data →",
    run: (go) => go("/data"),
  },
  {
    id: "chat",
    label: "Ask your mentor a question",
    cta: "Chat →",
    run: (go) => {
      primeChatPrefill(SUGGESTED_QUESTION);
      go("/");
    },
  },
  {
    id: "memo",
    label: "Capture a memo",
    cta: "Try >>",
    run: (go) => {
      primeChatPrefill(">> ");
      go("/");
    },
  },
];

/**
 * First-run guided checklist (Loop-8). Lives in the global chrome so it persists
 * across tabs and catches every real action. Each step checks off only when the
 * action actually lands — a source connected (confirmed from /api/sources), a
 * chat sent, a memo saved (both via the tour-step event the real code emits).
 * Finishing all three, or dismissing, stamps config.onboardedAt so it never
 * returns. Hidden entirely once `onboardedAt` is set.
 */
export function OnboardingTour({ onboardedAt }: { onboardedAt: string }) {
  const onboarded = Boolean(onboardedAt);
  const router = useRouter();
  const [done, setDone] = useState<Progress>(EMPTY);
  const [hidden, setHidden] = useState(false);
  const finishedRef = useRef(false);

  const allDone = done.source && done.chat && done.memo;

  // Confirm the source step against real server state (a source is connected
  // once its record holds rows) — never on a mere button press.
  const refreshSource = useCallback(async () => {
    try {
      const res = await fetch("/api/sources");
      if (!res.ok) return;
      const data = (await res.json()) as { sources?: { connected?: boolean }[] };
      if (data.sources?.some((s) => s.connected)) {
        setDone((d) => (d.source ? d : { ...d, source: true }));
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Restore cached progress, then re-confirm the source from the server.
  useEffect(() => {
    if (onboarded) return;
    try {
      const raw = window.localStorage.getItem(TOUR_PROGRESS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Progress>;
        setDone({ source: !!p.source, chat: !!p.chat, memo: !!p.memo });
      }
    } catch {
      /* ignore */
    }
    void refreshSource();
  }, [onboarded, refreshSource]);

  // Persist progress so a hard reload mid-tour keeps the checks.
  useEffect(() => {
    if (onboarded) return;
    try {
      window.localStorage.setItem(TOUR_PROGRESS_KEY, JSON.stringify(done));
    } catch {
      /* ignore */
    }
  }, [done, onboarded]);

  // Listen for real actions; re-confirm the source on focus too (covers connect
  // paths that don't emit while the user is on the Data tab).
  useEffect(() => {
    if (onboarded) return;
    const onStep = (e: Event) => {
      const step = (e as CustomEvent<TourStep>).detail;
      if (step === "source") void refreshSource();
      else if (step === "chat") setDone((d) => (d.chat ? d : { ...d, chat: true }));
      else if (step === "memo") setDone((d) => (d.memo ? d : { ...d, memo: true }));
    };
    const onFocus = () => void refreshSource();
    window.addEventListener(TOUR_STEP_EVENT, onStep as EventListener);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(TOUR_STEP_EVENT, onStep as EventListener);
      window.removeEventListener("focus", onFocus);
    };
  }, [onboarded, refreshSource]);

  const finish = useCallback(async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
      });
    } catch {
      /* the local hide still holds for this session */
    }
    try {
      window.localStorage.removeItem(TOUR_PROGRESS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // All three real actions done → stamp onboardedAt once (kept visible so the
  // user sees the win; the Done button closes it).
  useEffect(() => {
    if (!onboarded && allDone) void finish();
  }, [onboarded, allDone, finish]);

  if (onboarded || hidden) return null;

  const doneCount = Number(done.source) + Number(done.chat) + Number(done.memo);
  const go = (href: string) => router.push(href);

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[320px] max-w-[calc(100vw-2rem)]">
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <p className="text-sm font-semibold text-fg">
            {allDone ? "You're all set" : "Get started"}
          </p>
          <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-fg">
            {doneCount}/3
          </span>
          <button
            type="button"
            onClick={() => {
              void finish();
              setHidden(true);
            }}
            aria-label="Dismiss tour"
            className="ml-auto rounded-lg p-1 text-muted-fg transition-colors hover:bg-muted hover:text-fg"
          >
            <X width={15} height={15} />
          </button>
        </div>

        <ol className="divide-y divide-border">
          {STEPS.map((step, i) => {
            const complete = done[step.id];
            return (
              <li key={step.id} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
                    complete
                      ? "bg-accent text-accent-fg"
                      : "border border-border text-muted-fg",
                  )}
                >
                  {complete ? <Check width={13} height={13} /> : i + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 text-[13px]",
                    complete ? "text-muted-fg line-through" : "font-medium text-fg",
                  )}
                >
                  {step.label}
                </span>
                {complete ? null : (
                  <button
                    type="button"
                    onClick={() => step.run(go)}
                    className="shrink-0 rounded-lg border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-fg transition-colors hover:bg-muted"
                  >
                    {step.cta}
                  </button>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <p className="text-[11px] text-muted-fg">
            {allDone
              ? "Your mentor is grounded in your record."
              : "Each step checks off on the real action."}
          </p>
          <button
            type="button"
            onClick={() => {
              void finish();
              setHidden(true);
            }}
            className="shrink-0 text-[12px] font-medium text-muted-fg transition-colors hover:text-fg"
          >
            {allDone ? "Done" : "Skip"}
          </button>
        </div>
      </div>
    </div>
  );
}
