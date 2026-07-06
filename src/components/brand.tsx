/** agentqs wordmark + mark. Shared by the shell and the auth pages. */

const BRAND_FONT =
  "'Avenir Next', Avenir, Futura, 'Century Gothic', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Classic robot head, thin line art. Monochrome: strokes inherit currentColor,
 * so it renders black on light mode and white on dark mode.
 */
function Mark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* antenna */}
      <line x1="12" y1="6.4" x2="12" y2="4.6" />
      <circle cx="12" cy="3.4" r="1.1" fill="currentColor" stroke="none" />
      {/* head */}
      <rect x="4.5" y="6.4" width="15" height="12" rx="3" />
      {/* ears */}
      <line x1="1.9" y1="10.9" x2="1.9" y2="13.9" />
      <line x1="22.1" y1="10.9" x2="22.1" y2="13.9" />
      {/* eyes */}
      <circle cx="9.3" cy="11.6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="11.6" r="1.2" fill="currentColor" stroke="none" />
      {/* mouth */}
      <line x1="9.7" y1="15.3" x2="14.3" y2="15.3" />
    </svg>
  );
}

export function Brand({ size = "md" }: { size?: "md" | "lg" }) {
  const lg = size === "lg";
  return (
    <div className="flex items-center gap-2 text-fg">
      <Mark size={lg ? 34 : 24} />
      <span
        className={lg ? "text-2xl" : "text-lg"}
        style={{ fontFamily: BRAND_FONT, fontWeight: 500, letterSpacing: "0.09em" }}
      >
        QS
      </span>
    </div>
  );
}
