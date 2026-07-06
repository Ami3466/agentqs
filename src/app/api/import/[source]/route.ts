import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/session";
import { recordDir } from "@/lib/paths";
import { parseCsv, rebuild } from "@/lib/record";
import { pluginById } from "@/lib/importers/registry";
import { importPlugin, resolveCredential, windowDays, type ImporterPlugin } from "@/lib/importers/plugin";
import { wipeDemoOnImport } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeriesPoint {
  date: string;
  value: number;
}

/** Read record/daily/<id>.csv and summarize the plugin's primary metric. */
function status(plugin: ImporterPlugin) {
  const file = path.join(recordDir(), "daily", `${plugin.id}.csv`);
  const cfg = readConfig();
  const out = {
    id: plugin.id,
    name: plugin.name,
    detail: plugin.detail,
    live: plugin.live,
    connected: false,
    hasCredential: Boolean(resolveCredential(plugin, undefined, cfg)),
    credentialLabel: plugin.credentialLabel,
    credentialPlaceholder: plugin.credentialPlaceholder,
    primaryMetric: plugin.primaryMetric,
    unit: plugin.unit ?? "",
    syncedAt: cfg?.sourceSyncedAt?.[plugin.id] ?? null,
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
  const plugin = pluginById(params.source);
  if (!plugin) return NextResponse.json({ error: `Unknown source "${params.source}".` }, { status: 404 });
  return NextResponse.json(status(plugin));
}

/** Run the importer, persist a freshly given credential + sync time, rebuild. */
export async function POST(req: Request, { params }: { params: { source: string } }) {
  if (!getCurrentUser()) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const plugin = pluginById(params.source);
  if (!plugin) return NextResponse.json({ error: `Unknown source "${params.source}".` }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { credential?: string; days?: number };
  const cfg = readConfig();
  const credential = resolveCredential(plugin, body.credential, cfg);
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
    summary = await importPlugin(plugin, { credential, from, to }, recordDir());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  // Persist a freshly supplied credential + the sync time so status survives reloads.
  if (cfg) {
    if (body.credential && body.credential.trim()) {
      cfg.sourceCreds = { ...(cfg.sourceCreds ?? {}), [plugin.id]: body.credential.trim() };
    }
    cfg.sourceSyncedAt = { ...(cfg.sourceSyncedAt ?? {}), [plugin.id]: new Date().toISOString() };
    try {
      writeConfig(cfg);
    } catch {
      /* non-fatal: the record already has the data */
    }
  }

  const r = rebuild({ recordDir: recordDir() });

  return NextResponse.json({
    ok: true,
    id: plugin.id,
    name: plugin.name,
    from: summary.from,
    to: summary.to,
    days: summary.daysWithData,
    metrics: summary.metrics,
    cells: summary.cells,
    dailyRows: r.daily,
    syncedAt: cfg?.sourceSyncedAt?.[plugin.id] ?? null,
  });
}
