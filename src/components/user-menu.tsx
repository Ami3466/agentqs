"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logout } from "./icons";

export function UserMenu({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function logout() {
    setBusy(true);
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initial = username.charAt(0).toUpperCase() || "?";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label="Account menu"
      >
        {initial}
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-52 rounded-xl border border-border bg-card p-1.5 shadow-xl">
          <div className="px-2.5 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-fg">
              Signed in as
            </p>
            <p className="truncate text-sm font-medium text-fg">{username}</p>
          </div>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={logout}
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-fg transition-colors hover:bg-muted disabled:opacity-50"
          >
            <Logout width={15} height={15} />
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
