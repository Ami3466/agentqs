"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import { Check, Copy, HelpCircle, Play, Spinner } from "./icons";
import { Button } from "./ui";

/**
 * First-run onboarding: a Welcome popup BEFORE a spotlight tour. The popup offers
 * the CLI start command and a one-click generic demo (auto-wiped on the first real
 * import). Dismissing it launches the driver.js tour, which is also re-runnable any
 * time from the header Tour button (via the `agentqs:tour` event).
 */

const DONE_KEY = "agentqs.onboarded";
const START_CMD = "npx agentqs serve";

function runTour() {
  driver({
    showProgress: true,
    allowClose: true,
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    steps: [
      {
        element: "#tour-connect",
        popover: {
          title: "Connect / API",
          description: "Mint an API key and copy the CLI, curl, MCP and skill snippets.",
        },
      },
      {
        element: "#tour-tab-pipeline",
        popover: {
          title: "Pipeline",
          description: "Drop a file or connect a live source. It syncs into one daily record.",
        },
      },
      {
        element: "#tour-tab-journal",
        popover: {
          title: "Journal",
          description: "One timeline. Flip to the table for saved views.",
        },
      },
      {
        element: "#tour-mentor",
        popover: {
          title: "Skills",
          description: "Pick a skill and start a session. Manage skills in Settings.",
        },
      },
    ],
  }).drive();
}

export function Onboarding() {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (typeof window !== "undefined" && !window.localStorage.getItem(DONE_KEY)) {
      void fetch("/api/demo")
        .then((res) => res.json())
        .then((status) => {
          if (!cancelled && status?.hasUserData !== true) setShow(true);
        })
        .catch(() => undefined);
    }
    const onTour = () => runTour();
    window.addEventListener("agentqs:tour", onTour);
    return () => {
      cancelled = true;
      window.removeEventListener("agentqs:tour", onTour);
    };
  }, []);

  function finish(startTour: boolean) {
    window.localStorage.setItem(DONE_KEY, "1");
    setShow(false);
    if (startTour) setTimeout(runTour, 300);
  }

  async function startDemo() {
    setSeeding(true);
    try {
      await fetch("/api/demo", { method: "POST" });
      router.refresh();
    } finally {
      setSeeding(false);
      finish(true);
    }
  }

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-fg">Welcome to agentqs</h2>
        <p className="mt-1 text-sm text-muted-fg">
          Run from the terminal:
        </p>

        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2.5">
          <code className="scrollbar-thin overflow-x-auto font-mono text-[13px] text-fg">{START_CMD}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(START_CMD);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-fg hover:text-fg"
          >
            {copied ? <Check width={13} height={13} /> : <Copy width={13} height={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="mt-5 space-y-2">
          <Button
            type="button"
            variant="primary"
            className="w-full"
            onClick={() => void startDemo()}
            disabled={seeding}
          >
            {seeding ? <Spinner width={16} height={16} /> : <Play width={15} height={15} />}
            Start with demo data
          </Button>
          <p className="text-center text-[11px] text-muted-fg">
            Generic sample data. Wiped on the first real import.
          </p>
          <Button type="button" className="w-full" onClick={() => finish(true)} disabled={seeding}>
            Start empty &amp; take the tour
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Header button that re-runs the tour. */
export function TourButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("agentqs:tour"))}
      title="Replay the tour"
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] font-medium text-muted-fg transition-colors hover:bg-muted hover:text-fg"
    >
      <HelpCircle width={14} height={14} />
      <span className="hidden sm:inline">Tour</span>
    </button>
  );
}
