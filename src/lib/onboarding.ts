import fs from "fs";
import path from "path";
import { driveBackupConnected } from "./backup";
import { readConfig } from "./config";
import { pluginInstanceById } from "./importers/registry";
import { recordDir } from "./paths";

/**
 * THE onboarding structure — derived from live config, never a static doc that
 * rots. Every step names the exact CLI command, MCP tool and API call that
 * performs it, so an agent driving a fresh instance (or the Connect snippets
 * pointing one here) never guesses which face does what. Read-only; `done`
 * flips as the real state changes.
 */

export interface OnboardingStep {
  id: string;
  title: string;
  why: string;
  /** null = optional — sensible to skip, never blocks `nextStep`. */
  done: boolean | null;
  cli?: string;
  mcp?: string;
  api?: string;
}

export interface OnboardingGuide {
  steps: OnboardingStep[];
  nextStep: string | null; // first undone required step
}

export function onboardingGuide(): OnboardingGuide {
  const cfg = readConfig();
  const rDir = recordDir();
  const hasFile = (f: string) => {
    try {
      return fs.statSync(path.join(rDir, f)).size > 0;
    } catch {
      return false;
    }
  };
  const hasDaily = () => {
    try {
      return fs.readdirSync(path.join(rDir, "daily")).length > 0;
    } catch {
      return false;
    }
  };
  // A backup target's credential is NOT a connected data source — whichever way
  // it was stored (an OAuth grant OR a pasted token). Backups move data out; the
  // pipeline brings it in. Asking the plugin beats listing ids by hand: the next
  // backup target inherits the rule instead of silently ticking this step.
  const isBackupCred = (key: string) => Boolean(pluginInstanceById(key)?.plugin.backupTarget);
  // A GRANT ONLY COUNTS IF IT HOLDS A TOKEN. `Object.keys(sourceOAuth)` counted an entry
  // that holds nothing but a clientId + clientSecret — the APP KEY, saved once, before
  // anyone ever signed in. (That is the exact state of the author's own Spotify: key
  // saved, never authorized, zero rows.) So the checklist ticked "connect a source" as
  // DONE and `nextStep` walked straight past it, for someone who had connected nothing
  // at all. THE APP KEY AND THE LOGIN ARE TWO DIFFERENT THINGS — the rest of the
  // codebase knows that; this line did not. `connectionState` gets it right, so ask it.
  const hasToken = (key: string) => {
    const grant = cfg?.sourceOAuth?.[key];
    return Boolean(grant?.accessToken || grant?.refreshToken);
  };
  const dataSourceConnected = [
    ...Object.keys(cfg?.sourceCreds ?? {}),
    ...Object.keys(cfg?.sourceOAuth ?? {}).filter(hasToken),
  ].some((key) => !isBackupCred(key));
  // One definition of "Drive is connected", shared with backupStatus() — the
  // checklist and Settings → Data must never disagree about the same switch.
  const driveConnected = driveBackupConnected(cfg);

  const steps: OnboardingStep[] = [
    {
      id: "setup",
      title: "Create the account",
      why: "config.json is the instance — username, password hash, session secret.",
      done: Boolean(cfg),
      cli: "open the web app once (npm start → /setup)",
      api: 'POST /api/setup {"username":"…","password":"…","confirm":"…"} — first run only, 409 after',
    },
    {
      id: "api_key",
      title: "Mint the API key",
      why: "the bearer every non-browser client (CLI agents, MCP, Slack relay, curl) authenticates with.",
      done: Boolean(cfg?.apiKey),
      api: "POST /api/keys — browser session only (a leaked bearer must not mint keys); shown ONCE",
    },
    {
      id: "capture",
      title: "First capture",
      why: "anything in — a memo, a file, a folder; the inbox → structure loop starts here.",
      done: hasFile("inbox.jsonl") || hasFile("events.jsonl") || hasDaily(),
      cli: "agentqs import <file-or-folder>",
      mcp: 'import_tree {"dir":"…"} · then inbox_pending → structure {id, csv}',
      api: 'POST /api/inbox {"text":"…"}',
    },
    {
      id: "connect_sources",
      title: "Connect API sources",
      why: "connected ⇔ a stored credential; data alone never counts.",
      done: dataSourceConnected,
      cli: "agentqs source guide <id> → source connect <id> <key>; OAuth: agentqs source authorize <id> --client-id … --client-secret … [--origin <app-url>]",
      mcp: 'source_guide {"source"} · source_test · source_authorize',
      api: 'POST /api/import/<id> {"credential":"…"} (tests before saving) · OAuth: POST /api/oauth/<id> {"clientId","clientSecret"} → GET /api/oauth/callback',
    },
    {
      id: "schedule",
      title: "Schedule syncs",
      why: "an interval per source; the running app sweeps them, cron covers the rest.",
      done: Object.values(cfg?.sourceIntervals ?? {}).some((v) => v !== "off"),
      cli: "agentqs source interval <id> daily · crontab: 0 * * * * agentqs sync --due",
      api: 'POST /api/sources {"id":"…","interval":"daily"}',
    },
    {
      id: "backup_github",
      title: "Back up the record to GitHub",
      why: "a snapshot branch of the plain-text record in a private repo; oversized files excluded loudly.",
      done: Boolean(cfg?.backup?.github?.remote),
      cli: "agentqs backup github --remote <private-repo-url> [--token <pat>] · pause/resume: --schedule off|daily",
      mcp: 'backup_run {"target":"github"} · backup_status',
      api: 'POST /api/backup {"target":"github","remote":"…","token":"…"} · schedule: {"target":"github","schedule":"off"}',
    },
    {
      id: "backup_drive",
      title: "Back up everything to Google Drive",
      why: "the whole store as one AES-256-GCM archive — covers what GitHub can't. A backup target, not a data source: it never shows up in the pipeline.",
      done: driveConnected && Boolean(cfg?.backup?.passphrase),
      cli: "agentqs backup passphrase --generate (store it OFF this machine) → agentqs source authorize gdrive_backup --client-id … --client-secret … → agentqs backup drive --schedule daily",
      mcp: 'backup_passphrase {"generate":true} (store it OFF this machine) · source_authorize {"source":"gdrive_backup"} · backup_run {"target":"drive","schedule":"daily"} · backup_status',
      api: 'POST /api/backup {"target":"passphrase","generate":true} · POST /api/oauth/gdrive_backup {"clientId","clientSecret"} · POST /api/backup {"target":"drive","schedule":"daily"}',
    },
    {
      id: "channels",
      title: "Wire live capture (Slack / Telegram)",
      why: "messages land in the inbox from anywhere; signature-verified webhooks.",
      done: Boolean(cfg?.channels?.slackBotToken || cfg?.channels?.telegramBotToken),
      cli: "Settings → Channels in the web app (bot token + signing secret)",
      api: "webhook the platform calls: POST /api/channels/slack (Events URL) · /api/channels/telegram",
    },
    {
      id: "migrate",
      title: "Bring an existing record here",
      why: "a fresh instance pulls the whole history from the newest Drive archive — data moves, identity stays.",
      done: null,
      cli: "agentqs backup restore --latest --into-store",
      mcp: 'backup_restore {"confirm":"replace-record"}',
      api: 'POST /api/backup {"target":"restore","confirm":"replace-record"}',
    },
  ];

  return { steps, nextStep: steps.find((s) => s.done === false)?.id ?? null };
}
