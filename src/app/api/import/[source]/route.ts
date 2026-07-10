import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv } from "@/lib/record";
import { pluginInstanceById, pluginInstanceName, type PluginInstance } from "@/lib/importers/registry";
import { connectionState, resolveSyncCredential } from "@/lib/importers/plugin";
import { readSyncRuns } from "@/lib/sync-runs";
import { readSyncJob, startSyncJob } from "@/lib/sync-jobs";
import { wipeDemoOnImport } from "@/lib/demo";
import { connectDetectedApp, connectSource, syncSource, testSourceCredential } from "@/lib/cli-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeriesPoint {
  date: string;
  value: number;
}

/** Read record/daily/<instanceId>.csv and summarize the plugin's primary metric.
 *  Instance ids ("spotify-2") let one integration hold several accounts. */
function status({ plugin, instanceId }: PluginInstance) {
  const file = path.join(recordDir(), "daily", `${instanceId}.csv`);
  const cfg = readConfig();
  // connected = authorized to sync (user credential or opted-in detected app).
  // hasData = rows exist. NEVER derived from each other — an import must not
  // present a source as connected, and connecting starts with zero rows.
  const state = connectionState(plugin, cfg, instanceId, file);
  const lastRun = readSyncRuns().runs[instanceId] ?? null;
  const out = {
    id: instanceId,
    name: pluginInstanceName({ plugin, instanceId }),
    detail: plugin.detail,
    live: plugin.live,
    connected: state.connected,
    hasData: state.hasData,
    detectedApp: state.detectedApp,
    hasCredential: Boolean(resolveSyncCredential(plugin, undefined, cfg, instanceId)),
    credentialLabel: plugin.credentialLabel,
    credentialPlaceholder: plugin.credentialPlaceholder,
    // How to get the credential + whether this source connects via the OAuth
    // dance (expiring tokens) — the connect form renders both.
    credentialHelp: plugin.credentialHelp ?? null,
    oauth: plugin.oauth
      ? {
          supported: true,
          authorized: Boolean(
            cfg?.sourceOAuth?.[instanceId]?.refreshToken || cfg?.sourceOAuth?.[instanceId]?.accessToken,
          ),
          clientId: cfg?.sourceOAuth?.[instanceId]?.clientId ?? "",
        }
      : null,
    primaryMetric: plugin.primaryMetric,
    unit: plugin.unit ?? "",
    syncedAt: cfg?.sourceSyncedAt?.[instanceId] ?? null,
    // The background job (running or last finished) + the run ledger — the UI
    // derives its progress bar and its "last sync failed" line from these, so
    // both survive a page refresh.
    job: readSyncJob(instanceId),
    lastRun,
    days: 0,
    latest: null as number | null,
    average: null as number | null,
    series: [] as SeriesPoint[],
  };
  if (!fs.existsSync(file)) return out;
  const { header, rows } = parseCsv(fs.readFileSync(file, "utf8"));
  const di = header.indexOf("date");
  const mi = header.indexOf(plugin.primaryMetric);
  if (di < 0 || rows.length === 0) return out;
  out.days = rows.filter((r) => (r[di] ?? "").trim() !== "").length;
  if (mi >= 0) {
    const series: SeriesPoint[] = [];
    for (const r of rows) {
      const date = (r[di] ?? "").trim();
      const n = Number((r[mi] ?? "").trim());
      if (date && Number.isFinite(n)) series.push({ date, value: n });
    }
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (series.length) {
      out.latest = series[series.length - 1].value;
      out.average = Math.round((series.reduce((s, p) => s + p.value, 0) / series.length) * 100) / 100;
      out.series = series.slice(-30);
    }
  }
  return out;
}

/** Current state of a Tier-1 plugin source, read straight from the record. */
export async function GET(_req: Request, { params }: { params: { source: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const inst = pluginInstanceById(params.source);
  if (!inst) return NextResponse.json({ error: `Unknown source "${params.source}".` }, { status: 404 });
  return NextResponse.json(status(inst));
}

/**
 * Connect and/or sync a plugin source.
 *   { test: true, credential? }  → probe the credential against the real API;
 *                                  nothing saved, the API's own error returned.
 *   { credential }               → probe FIRST, save only a working key, then sync.
 *   {} / { useDetected: true }   → sync with the stored (or opted-in detected) key.
 * The sync itself runs as a BACKGROUND JOB (202): closing or refreshing the page
 * doesn't kill it, and GET reports its live phase/progress until it lands.
 */
export async function POST(req: Request, { params }: { params: { source: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const inst = pluginInstanceById(params.source);
  if (!inst) return NextResponse.json({ error: `Unknown source "${params.source}".` }, { status: 404 });
  const { plugin, instanceId } = inst;

  const body = (await req.json().catch(() => ({}))) as {
    credential?: string;
    days?: number;
    useDetected?: boolean;
    test?: boolean;
  };

  if (body.test === true) {
    try {
      return NextResponse.json(await testSourceCredential(instanceId, body.credential));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  // A freshly pasted credential must PROVE itself before it is stored — a typo'd
  // key fails here, loudly, instead of on next week's scheduled sync.
  if (body.credential && body.credential.trim()) {
    try {
      await testSourceCredential(instanceId, body.credential);
      connectSource(instanceId, body.credential);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  // "Connect (use detected app)" — imports the desktop app's login as this
  // source's SAVED credential (same store as a pasted key, revoked by
  // disconnect). Connected always means a stored credential; this is the only
  // thing discovery can ever do, and only through this explicit action.
  if (body.useDetected === true) {
    try {
      connectDetectedApp(instanceId);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  const cfg = readConfig();
  if (plugin.requiresCredential && !resolveSyncCredential(plugin, undefined, cfg, instanceId)) {
    return NextResponse.json(
      { error: `Add a ${plugin.credentialLabel} to sync ${plugin.name}.` },
      { status: 400 },
    );
  }

  wipeDemoOnImport(); // first real import clears the generic demo record

  const days = body.days && body.days > 0 ? body.days : undefined;
  const job = startSyncJob(instanceId, async (progress) => {
    const r = await syncSource({ id: instanceId, days, onProgress: progress });
    return { days: r.days, dailyRows: r.dailyRows };
  });

  return NextResponse.json(
    { ok: true, id: instanceId, name: pluginInstanceName(inst), job },
    { status: 202 },
  );
}
