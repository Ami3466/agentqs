"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { twMerge } from "tailwind-merge";

/** Joins class names and resolves Tailwind conflicts (a passed `w-40` beats a base `w-full`). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}

/** Compact relative timestamp for list rows: "just now", "5m ago", "3d ago". */
export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---- Button ---------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg hover:opacity-90 border border-transparent shadow-sm",
  secondary:
    "bg-card text-card-fg hover:bg-muted border border-border",
  ghost: "bg-transparent text-muted-fg hover:bg-muted hover:text-fg border border-transparent",
  danger:
    "bg-transparent text-destructive hover:bg-destructive/10 border border-border",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        // whitespace-nowrap: a button label is always ONE line — tight flex rows
        // must truncate their text, never wrap their buttons.
        "inline-flex items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:opacity-50 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";

// ---- Input ----------------------------------------------------------------

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-10 w-full rounded-lg border border-input bg-bg px-3 text-sm text-fg",
      "placeholder:text-muted-fg/70 transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring/60",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

// ---- Segmented ------------------------------------------------------------

/** Segmented button group — the standard picker for a handful of exclusive
 * choices (view modes, time ranges). `sm` lines up with h-8 filter controls. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("flex shrink-0 rounded-lg border border-border bg-card p-0.5", className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "whitespace-nowrap rounded-md font-medium transition-colors",
            size === "sm" ? "h-[26px] px-2.5 text-[13px]" : "px-3 py-1.5 text-sm",
            value === o.value ? "bg-muted text-fg" : "text-muted-fg hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- TabBar ---------------------------------------------------------------

/** Card-header tab strip with per-tab counts (Sources, Data inbox). One line,
 *  never wraps. Use Segmented for plain exclusive choices without counts. */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex shrink-0 rounded-lg border border-border bg-muted p-0.5 text-[13px]">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          aria-pressed={value === t.value}
          className={cn(
            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors",
            value === t.value ? "bg-card text-fg shadow-sm" : "text-muted-fg hover:text-fg",
          )}
        >
          {t.label}
          {t.count != null ? (
            <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-fg">{t.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// ---- Select ---------------------------------------------------------------

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  // className lands on both layers: layout (w-*, flex-*) sizes the wrapper,
  // control styles (h-*, text-*) size the select; the select always fills the wrapper.
  <div className={cn("relative w-full", className)}>
    <select
      ref={ref}
      className={cn(
        "h-10 w-full appearance-none rounded-lg border border-input bg-bg pl-3 pr-8 text-sm text-fg",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-ring/60",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-fg"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </div>
));
Select.displayName = "Select";

// ---- Layout primitives ----------------------------------------------------

export function Card({
  className,
  children,
  id,
}: {
  className?: string;
  children: ReactNode;
  id?: string; // anchor target (e.g. /settings#skills)
}) {
  return (
    <div
      id={id}
      className={cn(
        "rounded-xl border border-border bg-card text-card-fg shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-fg"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-fg">{hint}</p> : null}
    </div>
  );
}

/** Labelled checkbox with an optional hint line — the standard settings toggle. */
export function Checkbox({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-start gap-2.5", disabled ? "opacity-50" : "cursor-pointer")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint ? <span className="block text-xs text-muted-fg">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-fg">
      {children}
    </span>
  );
}
