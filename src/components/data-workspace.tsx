"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { Dropzone } from "@/components/dropzone";
import { SourcesPanel } from "@/components/sources-panel";
import { InboxPanel } from "@/components/inbox-panel";

/**
 * Client shell for the Data tab. Top-down flow that reads in the order it works:
 * drop a file (photos included) → it lands in the inbox → Structure it. Sources are
 * the separate, live-feed lane below. One shared `version` counter fans a single
 * refetch across every panel after any mutation (a drop, a structure/discard, an
 * auto-sync). The daily/Log table lives on the Journal tab, not here.
 */
export function DataWorkspace() {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  // "Automate imports" (inbox) → open the automation setup flow: focus the Sources
  // card on its Connections catalog and scroll it into view. Bumping the signal
  // re-triggers even if you're already looking at that tab.
  const [automateSignal, setAutomateSignal] = useState(0);
  const openAutomation = () => setAutomateSignal((n) => n + 1);

  return (
    <div className="space-y-4">
      <Dropzone onUploaded={bump} />

      <Card>
        <InboxPanel version={version} onChanged={bump} onAutomate={openAutomation} />
      </Card>

      <Card>
        <SourcesPanel version={version} onChanged={bump} automateSignal={automateSignal} />
      </Card>
    </div>
  );
}
