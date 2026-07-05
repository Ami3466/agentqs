"use client";

import { useTheme } from "./theme-provider";
import { Moon, Sun } from "./icons";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      title={`Switch to ${dark ? "light" : "dark"} theme`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-fg transition-colors hover:bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {dark ? <Moon /> : <Sun />}
    </button>
  );
}
