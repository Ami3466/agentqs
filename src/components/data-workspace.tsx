"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { InboxPanel } from "@/components/inbox-panel";
import { DailyPreview } from "@/components/daily-preview";

/**
 * Client shell for the Data tab. Holds the one shared `version` counter so an
 * inbox mutation (upload · structure · discard) refetches both the pending list
 * and the daily-table preview from a single source of truth. The server-rendered
 * sources card (GitHub + stubs) is passed straight through as `children`.
 */
export function DataWorkspace({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-[1fr_300px]">
        {children}
        <Card>
          <InboxPanel version={version} onChanged={bump} />
        </Card>
      </div>
      <Card className="mt-4">
        <DailyPreview version={version} />
      </Card>
    </>
  );
}
