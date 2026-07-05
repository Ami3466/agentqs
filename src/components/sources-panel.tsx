"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { AlertTriangle, Check, Clock, Spinner, Terminal, Upload } from "@/components/icons";
import { brandIcon } from "@/components/brand-icons";
import { GithubConnect } from "@/components/github-connect";
import { SourceConnect } from "@/components/source-connect";
import { CopyBlock } from "@/components/copy-block";
import { IntervalSelect } from "@/components/interval-select";
import { Badge, Button, cn } from "@/components/ui";
import { uploadFilesToInbox } from "@/lib/inbox-upload";
import { ago, type Interval, type SourceView } from "@/lib/sources";
import { markTourStep } from "@/lib/tour";

/**
 * The Data-tab sources list + sync engine (Loop 10). Single fetcher/persister of
 * /api/sources: renders every source (GitHub via the rich GithubConnect row, the
 * rest via a generic row), owns the per-source interval dropdowns, and runs
 * lazy-sync-on-open — on mount it POSTs every DUE api source's endpoint, then
 * bumps the shared `version` so the daily preview refetches. Manual sources that
 * fall behind their interval show a stale badge (they can't auto-sync).
 */
export function SourcesPanel({
  version,
  onChanged,
}: {
  version: number;
  onChanged: () => void;
}) {
  const [sources, setSources] = useState<SourceView[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [autoMsg, setAutoMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const ranAuto = useRef(false);

  const load = useCallback(async (): Promise<SourceView[] | null> => {
    const res = await fetch("/api/sources");
    if (!res.ok) return null;
    const data = (await res.json()) as { sources: SourceView[] };
    setSources(data.sources);
    return data.sources;
  }, []);

  // Load on mount + whenever the shared version bumps. The first load also fires
  // lazy-sync-on-open for any due api source (guarded so it runs exactly once).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await load();
      if (cancelled || ranAuto.current) return;
      ranAuto.current = true;
      const due = (list ?? []).filter((s) => s.due && s.syncEndpoint);
      if (!due.length) return;
      setSyncing(true);
      setAutoMsg(`Auto-syncing ${due.map((d) => d.name).join(", ")}…`);
      await Promise.all(
        due.map((s) =>
          fetch(s.syncEndpoint as string, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }).catch(() => undefined),
        ),
      );
      if (cancelled) return;
      setSyncing(false);
      setAutoMsg(`Auto-synced ${due.map((d) => d.name).join(", ")} on open.`);
      onChanged(); // bump → daily preview + this list refetch (version effect)
      window.setTimeout(() => setAutoMsg(""), 6000);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function changeInterval(id: string, interval: Interval) {
    setSavingId(id);
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, interval }),
      });
      if (res.ok) {
        const data = (await res.json()) as { sources: SourceView[] };
        setSources(data.sources);
      }
    } finally {
      setSavingId(null);
    }
  }

  const github = sources?.find((s) => s.id === "github");
  const others = (sources ?? []).filter((s) => s.id !== "github");
  // api plugin sources get the rich connect/sync row; the rest (manual drops,
  // not-yet-live placeholders) get the generic row.
  const isPluginRow = (s: SourceView) => s.kind === "api" && s.id !== "github";

  return (
    <div>
      {autoMsg ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs text-accent">
          {syncing ? <Spinner width={13} height={13} /> : <Check width={13} height={13} />}
          {autoMsg}
        </div>
      ) : null}

      <div className="divide-y divide-border">
        <GithubConnect
          version={version}
          interval={github?.interval ?? "off"}
          due={Boolean(github?.due)}
          savingInterval={savingId === "github"}
          onIntervalChange={(i) => changeInterval("github", i)}
        />

        {others.map((s) =>
          isPluginRow(s) ? (
            <SourceConnect
              key={s.id}
              id={s.id}
              version={version}
              interval={s.interval}
              due={s.due}
              savingInterval={savingId === s.id}
              onIntervalChange={(i) => changeInterval(s.id, i)}
            />
          ) : (
            <SourceRow
              key={s.id}
              source={s}
              saving={savingId === s.id}
              onIntervalChange={(i) => changeInterval(s.id, i)}
              onChanged={onChanged}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** Generic (non-GitHub) manual source row. Connected sources get an interval
 *  dropdown (overdue → stale badge). Not-yet-connected sources are never a dead
 *  end: a `cli` source (browser history, chat.db, Apple Health, OwnTracks) reveals
 *  the exact `agentqs import:file` command; an `upload` source (WhatsApp/Notion/
 *  Takeout/Slack/Telegram export) reveals a real upload + drag-drop into the inbox. */
function SourceRow({
  source,
  saving,
  onIntervalChange,
  onChanged,
}: {
  source: SourceView;
  saving: boolean;
  onIntervalChange: (i: Interval) => void;
  onChanged: () => void;
}) {
  const { id, name, kind, detail, connected, lastSync, stale, interval, connectVia } = source;
  const Icon = brandIcon(id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | File[]) {
    if (!Array.from(files).length) return;
    setBusy(true);
    setFlash("");
    try {
      const { added, skipped } = await uploadFilesToInbox(files, id);
      if (added) {
        setFlash(`${added} file${added === 1 ? "" : "s"} added to the inbox — hit Structure to turn it into daily rows.`);
        onChanged();
        markTourStep("source"); // ping the tour; it re-confirms once the source has rows
      } else if (skipped.length) {
        setFlash(`Skipped ${skipped[0]}.`);
      }
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer?.files?.length) void upload(e.dataTransfer.files);
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-fg">
          <Icon width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-fg">{name}</p>
            <Badge>{kind}</Badge>
            {stale ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-fg"
                title={`No fresh data within its ${interval} interval — refresh this source.`}
              >
                <AlertTriangle width={11} height={11} /> stale
              </span>
            ) : connected ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                <Check width={12} height={12} /> connected
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-fg">
            {connected ? (
              <span className="inline-flex items-center gap-1">
                <Clock width={11} height={11} /> updated {ago(lastSync)}
              </span>
            ) : (
              detail
            )}
          </p>
        </div>
        <div className="shrink-0">
          {connected ? (
            <div className="flex items-center gap-1.5">
              {saving ? <Spinner width={13} height={13} className="text-muted-fg" /> : null}
              <IntervalSelect value={interval} onChange={onIntervalChange} disabled={saving} />
            </div>
          ) : (
            <Button
              size="sm"
              variant={open ? "secondary" : "primary"}
              onClick={() => setOpen((v) => !v)}
            >
              {connectVia === "upload" ? <Upload width={14} height={14} /> : <Terminal width={14} height={14} />}
              {connectVia === "upload" ? "Import" : "Setup"}
            </Button>
          )}
        </div>
      </div>

      {open && !connected ? (
        <div className="mt-3 space-y-2 pl-12">
          {source.connectHint ? <p className="text-xs text-muted-fg">{source.connectHint}</p> : null}

          {connectVia === "cli" && source.importCmd ? (
            <>
              <CopyBlock label="Run locally" code={source.importCmd} />
              <p className="text-[11px] text-muted-fg">
                Reads a local file, so it runs from the CLI; rows appear here after it syncs.
              </p>
            </>
          ) : null}

          {connectVia === "upload" ? (
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => {
                e.preventDefault();
                setDrag(false);
              }}
              onDrop={onDrop}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-3 py-5 text-center text-xs transition-colors",
                drag ? "border-accent bg-accent/10 text-accent" : "border-border text-muted-fg",
              )}
            >
              <Upload width={18} height={18} className="opacity-70" />
              <p>
                Drop your export here or{" "}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="font-medium text-fg underline underline-offset-2 hover:text-accent"
                >
                  choose a file
                </button>
                .
              </p>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={source.uploadAccept ?? undefined}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          ) : null}

          {busy ? (
            <p className="inline-flex items-center gap-1 text-xs text-muted-fg">
              <Spinner width={12} height={12} /> Uploading…
            </p>
          ) : null}
          {flash ? <p className="text-xs text-accent">{flash}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
