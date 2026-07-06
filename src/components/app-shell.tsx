import type { ReactNode } from "react";
import { Brand } from "./brand";
import { ConnectApi } from "./connect-api";
import { Onboarding, TourButton } from "./onboarding";
import { TabNav } from "./tab-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { VoiceMemo } from "./voice-memo";

/**
 * Supabase-style two-row chrome: brand + project + Connect/API + account on top,
 * the 4-tab nav on a second row. Wraps every authenticated page.
 */
export function AppShell({
  username,
  children,
}: {
  username: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur">
        {/* top row */}
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <Brand />
          <div className="ml-auto flex items-center gap-2">
            <ConnectApi />
            <TourButton />
            <VoiceMemo />
            <ThemeToggle />
            <UserMenu username={username} />
          </div>
        </div>
        {/* tab row */}
        <div className="flex h-12 items-center px-2 sm:px-4">
          <TabNav />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>

      <Onboarding />
    </div>
  );
}
