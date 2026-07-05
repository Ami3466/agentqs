import type { ReactNode } from "react";
import { Brand } from "./brand";
import { ThemeToggle } from "./theme-toggle";

/** Centered card layout for the unauthenticated /setup and /login pages. */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand size="lg" />
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-7">
          <div className="mb-5 text-center">
            <h1 className="text-lg font-semibold text-fg">{title}</h1>
            {subtitle ? (
              <p className="mt-1 text-sm text-muted-fg">{subtitle}</p>
            ) : null}
          </div>
          {children}
        </div>

        <p className="mt-6 text-center text-xs text-muted-fg">
          Your data lives in your own git repo, on your own server.
        </p>
      </div>
    </div>
  );
}
