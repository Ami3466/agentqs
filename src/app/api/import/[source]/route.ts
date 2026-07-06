import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv, rebuild } from "@/lib/record";
import { pluginInstanceById, pluginInstanceName, type PluginInstance } from "@/lib/importers/registry";
import { importPlugin, resolveCredential, windowDays } from "@/lib/importers/plugin";
import { wipeDemoOnImport } from "@/lib/demo";

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
  const out = {
    id: instanceId,
    name: pluginInstanceName({ plugin, instanceId }),
    detail: plugin.detail,
    live: plugin.live,
    connected: false,
    hasCredential: Boolean(resolveCredential(plugin, undefined, cfg, instanceId)),
    credentialLabel: plugin.credentialLabel,
    credentialPlaceholder: plugin.credentialPlaceholder,
    primaryMetric: plugin.primaryMetric,
    unit: plugin.unit ?? "",
    syncedAt: cfg?.sourceSyncedAt?.[instanceId] ?? null,
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
  out.connected = true;
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

/** Run the importer, persist a freshly given credential + sync time, rebuild. */
export async function POST(req: Request, { params }: { params: { source: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const inst = pluginInstanceById(params.source);
  if (!inst) return NextResponse.json({ error: `Unknown source "${params.source}".` }, { status: 404 });
  const { plugin, instanceId } = inst;

  const body = (await req.json().catch(() => ({}))) as { credential?: string; days?: number };
  const cfg = readConfig();
  const credential = resolveCredential(plugin, body.credential, cfg, instanceId);
  if (plugin.requiresCredential && !credential) {
    return NextResponse.json(
      { error: `Add a ${plugin.credentialLabel} to sync ${plugin.name}.` },
      { status: 400 },
    );
  }

  const { from, to } = windowDays(body.days && body.days > 0 ? body.days : 90);

  wipeDemoOnImport(); // first real import clears the generic demo record

  let summary;
  try {
    summary = await importPlugin(plugin, { credential, from, to }, recordDir(), instanceId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Persist a freshly supplied credential + the sync time so status survives reloads.
  const latest = readConfig();
  if (latest) {
    if (body.credential && body.credential.trim()) {
      latest.sourceCreds = { ...(latest.sourceCreds ?? {}), [instanceId]: body.credential.trim() };
    }
    latest.sourceSyncedAt = { ...(latest.sourceSyncedAt ?? {}), [instanceId]: new Date().toISOString() };
    try {
      writeConfig(latest);
    } catch {
      /* non-fatal: the record already has the data */
    }
  }

  const r = rebuild({ recordDir: recordDir() });

  return NextResponse.json({
    ok: true,
    id: instanceId,
    name: pluginInstanceName(inst),
    from: summary.from,
    to: summary.to,
    days: summary.daysWithData,
    metrics: summary.metrics,
    cells: summary.cells,
    dailyRows: r.daily,
    syncedAt: latest?.sourceSyncedAt?.[instanceId] ?? null,
  });
}
