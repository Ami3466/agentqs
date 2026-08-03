"use client";

import { SourceHeader } from "@/components/source-title";
import { ago, type SourceView } from "@/lib/sources";
import { cn, LinkButton } from "@/components/ui";

/**
 * A live-capture channel (Slack · Telegram) in the Pipeline list.
 *
 * A channel is PUSHED to our webhook: there is no key to paste here, nothing to
 * poll, and nothing to "sync now". It used to fall through to SourceConnect — the
 * generic paste-an-API-key row — which asked /api/import/slack for its status, got
 * a 404 (no such importer, correctly), and therefore rendered a connected channel
 * as not connected with a Connect button that opened a credential form for a
 * credential that lives somewhere else. The row now reads the ONE truth the panel
 * already has (/api/sources) and sends both actions to where the bot token
 * actually lives: Settings → Channels.
 */
export function ChannelRow({ source }: { source: SourceView }) {
  const { id, name, connected, hasData, detail, lastSync, lastRunError } = source;
  const verdict = source.delivery?.verdict ?? null;
  const lastDeliveryAt = source.delivery?.lastAt ?? null;
  const lastOutcome = source.delivery?.lastOutcome ?? null;
  const lastDetail = source.delivery?.lastDetail ?? null;
  // A channel's "what landed" is inbox captures, not daily rows — the registry
  // already phrased it ("5 messages captured · …"), and its recency is the last
  // message, never a sync that never happens.
  const meta = [detail, lastSync ? `last message ${ago(lastSync)}` : null].filter(Boolean).join(" · ");

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <SourceHeader
          id={id}
          name={name}
          connected={connected}
          hasData={hasData ?? false}
          provenance={source.provenance}
          detail={meta}
          lastSync={null}
          href={null}
          title={`${name} messages land in your inbox on this page. The bot token lives in Settings → Channels.`}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <LinkButton
            href="/settings#channels"
            size="sm"
            variant={connected ? "ghost" : "primary"}
            title={
              connected
                ? `Change the ${name} bot token, signing secret, or whether it replies with AI.`
                : `Set up the ${name} bot — token, webhook URL and reply mode.`
            }
          >
            {connected ? "Manage" : "Connect"}
          </LinkButton>
        </div>
      </div>
      {/* Inbound health. "Connected" only means a token is stored — it stays true
          while the platform has stopped calling, or while we refuse every call it
          makes. Those are different bugs with different fixes, so the row says
          which one it is instead of leaving an empty inbox to be interpreted. */}
      {verdict && verdict.tone !== "ok" ? (
        <p
          className={cn("mt-2 pl-12 text-xs", verdict.tone === "error" ? "text-destructive" : "text-warning")}
          title={source.delivery?.rejectedDetail ?? verdict.text}
        >
          {verdict.text}
        </p>
      ) : null}
      {lastDeliveryAt ? (
        <p className="mt-1 pl-12 text-xs text-muted-fg" title={`${lastOutcome ?? ""} ${lastDetail ?? ""}`.trim()}>
          Last delivery from {name}: {ago(lastDeliveryAt)}
          {lastOutcome ? ` · ${lastOutcome}` : ""}
        </p>
      ) : null}
      {lastRunError ? (
        <p className="mt-2 pl-12 text-xs text-destructive" title={lastRunError}>
          Last reply failed: {lastRunError}
        </p>
      ) : null}
    </div>
  );
}
