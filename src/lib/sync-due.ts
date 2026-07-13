import { backupStatus } from "./backup";
import { readConfig } from "./config";
import { recordDir } from "./paths";
import { buildSources } from "./source-registry";
import { type SourceView } from "./sources";
import { recordDueRun } from "./sync-runs";

/**
 * The cron entrypoint for automated scraping: run every source whose schedule
 * says it's due — API sources (github, whoop, plugin accounts) and browser
 * automations (headless replay) alike. Dueness is the SAME `due` flag the
 * sources panel uses for lazy-sync-on-open, so `agentqs sync --due` from a
 * crontab and opening the app converge on identical behavior: set a source's
 * interval (hourly | daily | weekly) and either surface runs it when the time
 * comes. Sources that aren't due are reported, not silently dropped.
 *
 * The runners are injectable so the selection logic — the part cron depends on —
 * is testable offline; the defaults are the real cli-core sync paths.
 */
export interface DueRunners {
  api: (id: string) => Promise<unknown>;
  automation: (id: string) => Promise<unknown>;
  /** The Drive backup — a target, not a source, so it gets its own runner. */
  backup: () => Promise<unknown>;
}

export interface DueResult {
  id: string;
  name: string;
  kind: "api" | "automation";
  ok: boolean;
  error?: string;
}

export interface SyncDueSummary {
  due: number;
  synced: DueResult[];
  failed: DueResult[];
  skipped: { id: string; interval: string; reason: string }[];
}

async function defaultRunners(): Promise<DueRunners> {
  const core = await import("./cli-core");
  return {
    api: (id) => core.syncSource({ id }),
    automation: (id) => core.automationRun({ id }),
    backup: () => core.backupDrive(),
  };
}

/** Which schedulable sources exist and whether each is due right now. */
export function dueSources(dir: string = recordDir()): SourceView[] {
  return buildSources(readConfig(), dir).filter((s) => s.interval !== "off");
}

export async function syncDue(runners?: DueRunners, dir: string = recordDir()): Promise<SyncDueSummary> {
  recordDueRun(); // scheduler heartbeat: proves cron/launchd sweeps reach the app
  const run = runners ?? (await defaultRunners());
  const scheduled = dueSources(dir);
  const synced: DueResult[] = [];
  const failed: DueResult[] = [];
  const skipped: { id: string; interval: string; reason: string }[] = [];
  for (const s of scheduled) {
    if (!s.due) {
      skipped.push({ id: s.id, interval: String(s.interval), reason: s.connected ? "not due yet" : "not connected" });
      continue;
    }
    const kind = s.automation ? "automation" : "api";
    try {
      await (s.automation ? run.automation(s.id) : run.api(s.id));
      synced.push({ id: s.id, name: s.name, kind, ok: true });
    } catch (e) {
      failed.push({ id: s.id, name: s.name, kind, ok: false, error: (e as Error).message });
    }
  }
  // Both off-site BACKUPS ride the same sweep — neither is a source (no source
  // row, no daily CSV: they move data OUT, they don't bring any in), but
  // due-ness and failure visibility work identically, so a failing push or
  // upload shows up next to a failing sync, never silently.
  const backup = backupStatus();
  if (backup.github.dueNow) {
    try {
      const { backupGithub } = await import("./backup");
      await backupGithub();
      synced.push({ id: "backup_github", name: "GitHub backup", kind: "api", ok: true });
    } catch (e) {
      failed.push({ id: "backup_github", name: "GitHub backup", kind: "api", ok: false, error: (e as Error).message });
    }
  }
  if (backup.drive.dueNow) {
    try {
      await run.backup();
      synced.push({ id: "backup_drive", name: "Google Drive backup", kind: "api", ok: true });
    } catch (e) {
      failed.push({
        id: "backup_drive",
        name: "Google Drive backup",
        kind: "api",
        ok: false,
        error: (e as Error).message,
      });
    }
  }
  return { due: synced.length + failed.length, synced, failed, skipped };
}
