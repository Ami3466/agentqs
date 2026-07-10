"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { Dropzone } from "@/components/dropzone";
import { SourcesPanel } from "@/components/sources-panel";
import { InboxPanel } from "@/components/inbox-panel";
import { DataLog } from "@/components/data-log";

/**
 * Client shell for the Pipeline tab. Top-down flow that reads in the order it works:
 * drop a file (photos included) → it lands in the inbox → Structure it. Sources are
 * the separate, live-feed lane below; the Log is the audit trail of every capture
 * (review, reject, or hand to the AI). One shared `version` counter fans a single
 * refetch across every panel after any mutation (a drop, a structure/discard, an
 * auto-sync). The daily table lives on the Journal tab, not here.
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
        <DataLog version={version} onChanged={bump} />
      </Card>
    </div>
  );
}
