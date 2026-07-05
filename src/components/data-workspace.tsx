"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { SourcesPanel } from "@/components/sources-panel";
import { InboxPanel } from "@/components/inbox-panel";
import { DailyPreview } from "@/components/daily-preview";

/**
 * Client shell for the Data tab. Holds the one shared `version` counter so any
 * mutation (an inbox upload · structure · discard, or a source auto-sync) refetches
 * every panel from a single source of truth: the sources list, the pending inbox,
 * and the daily-table preview all read `version`.
 */
export function DataWorkspace() {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-[1fr_300px]">
        <Card>
          <SourcesPanel version={version} onChanged={bump} />
        </Card>
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
