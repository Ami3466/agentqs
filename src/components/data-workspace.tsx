"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { Dropzone } from "@/components/dropzone";
import { SourcesPanel } from "@/components/sources-panel";
import { InboxPanel } from "@/components/inbox-panel";
import { DailyPreview } from "@/components/daily-preview";

/**
 * Client shell for the Data tab (Loop 2 redesign). Top-down flow that reads in the
 * order it works: drop a file → it lands in the inbox → Structure it → watch it
 * fill the daily table. Sources are the separate, live-feed lane below. One shared
 * `version` counter fans a single refetch across every panel after any mutation
 * (a drop, a structure/discard, an auto-sync).
 */
export function DataWorkspace() {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  return (
    <div className="space-y-4">
      <Dropzone onUploaded={bump} />

      <Card>
        <InboxPanel version={version} onChanged={bump} />
      </Card>

      <Card>
        <SourcesPanel version={version} onChanged={bump} />
      </Card>

      <Card>
        <DailyPreview version={version} />
      </Card>
    </div>
  );
}
