/** agentqs wordmark + mark. Shared by the shell and the auth pages. */

/**
 * Minimal monochrome mark: a rounded speech node sitting on a three-tick record
 * baseline — the whole product in one glyph (a mentor that talks over your daily
 * record). No sparkle, no colour: it inherits the accent tile's foreground.
 */
function Mark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8" r="4.5" />
      <path d="M7 15.5h2M11 15.5h2M15 15.5h2M8 19.5h3M14 19.5h2" />
    </svg>
  );
}

export function Brand({ size = "md" }: { size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={
          lg
            ? "flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-fg"
            : "flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg"
        }
      >
        <Mark size={lg ? 24 : 17} />
      </span>
      <span
        className={
          lg
            ? "text-xl font-semibold tracking-tight text-fg"
            : "text-[15px] font-semibold tracking-tight text-fg"
        }
      >
        agentqs
      </span>
    </div>
  );
}
