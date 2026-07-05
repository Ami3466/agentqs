"use client";

import { useState } from "react";
import { Check, Copy } from "@/components/icons";

/**
 * A labelled, copyable code block — one monospace command/snippet with a Copy
 * button. Shared by the Connect/API bar and the Data-tab file-source rows so the
 * exact CLI command a source runs is shown (and copied) the same way everywhere.
 */
export function CopyBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-fg">
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex items-center gap-1 text-[11px] text-muted-fg transition-colors hover:text-fg"
        >
          {copied ? <Check width={12} height={12} /> : <Copy width={12} height={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg">
        {code}
      </pre>
    </div>
  );
}
