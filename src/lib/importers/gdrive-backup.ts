import { netFetch, type ImporterContext, type ImporterPlugin, type ImporterResult } from "./plugin";
import { driveErrorDetail } from "../backup";

/**
 * Google Drive backup — a BACKUP TARGET, not a data source. It rides the
 * importer-plugin contract for one thing only: the credential machinery (the
 * OAuth dance on drive.file scope — the app only ever sees files it created —
 * plus token refresh, `source authorize` and `source test`). Everything else a
 * source does, it deliberately does NOT do: it never appears in the Pipeline
 * (that list is the data coming IN), never lands a row in the record, and
 * schedules itself under `config.backup.drive.interval`, not `sourceIntervals`.
 *
 * The run lives in src/lib/backup.ts (`runDriveBackup`, reached through
 * `backupDrive()`), its face is Settings → Data / `agentqs backup drive`.
 * `probe` keeps `source test` cheap: proving the credential must never upload a
 * multi-hundred-MB archive. A Drive that IMPORTS files would be a separate,
 * ordinary source plugin — pulling data in has nothing to do with backup.
 */
export const gdriveBackupPlugin: ImporterPlugin = {
  id: "gdrive_backup",
  name: "Google Drive backup",
  detail: "encrypted store archive uploaded to Drive",
  live: true,
  backupTarget: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "ya29.… (OAuth access token)",
  credentialHelp: {
    url: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "In Google Cloud Console, create a project and enable the Google Drive API.",
      "Configure the OAuth consent screen (External) and add your own Google account as a test user.",
      "Credentials → Create OAuth client ID → Web application, with the Redirect URI shown here.",
      "Paste the Client ID and Client Secret into the fields here and press Authorize.",
      "Set the archive passphrase once: `agentqs backup passphrase --generate` — archives are unreadable without it, so store a copy somewhere safe.",
    ],
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.file",
    tokenAuth: "body",
    // offline + consent → Google actually returns a refresh token, every time.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  async probe(ctx: ImporterContext): Promise<string> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const res = await netFetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
      { headers: { Authorization: `Bearer ${ctx.credential ?? ""}` } },
      fetchImpl,
    );
    if (!res.ok) throw new Error(`Drive about → HTTP ${res.status}: ${driveErrorDetail(await res.text())}`);
    const who = (await res.json()) as { user?: { emailAddress?: string } };
    return `Drive reachable as ${who.user?.emailAddress ?? "unknown account"}`;
  },
  /** A backup target is never synced as a source — `backupDrive()` runs it. The
   *  throw is the guard rail: no path may quietly land backup receipts in the
   *  record (the record is data you captured, not bookkeeping about backups). */
  async fetch(): Promise<ImporterResult> {
    throw new Error(
      "Google Drive is a backup target, not a data source — run `agentqs backup drive` " +
        '(API: POST /api/backup {"target":"drive"}), or set its cadence with `agentqs backup drive --schedule daily`.',
    );
  },
};
