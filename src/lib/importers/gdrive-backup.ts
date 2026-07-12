import type { ImporterContext, ImporterPlugin, ImporterResult } from "./plugin";
import { runDriveBackup } from "../backup";

/**
 * Google Drive backup — an EXPORT target riding the importer-plugin contract,
 * so it inherits the whole source machinery instead of duplicating it:
 * connect = the standard OAuth dance (drive.file scope — the app only ever
 * sees files it created), schedule = the source interval, sync = tar+encrypt
 * the whole store and upload ONE archive (src/lib/backup.ts is the brain).
 * The "table" it lands is the receipt — backup_mb on the day it ran — so the
 * Pipeline tab shows schedule / last run / history like any source. `probe`
 * keeps `source test` cheap: proving the credential must never upload a
 * multi-hundred-MB archive.
 */
export const gdriveBackupPlugin: ImporterPlugin = {
  id: "gdrive_backup",
  name: "Google Drive backup",
  detail: "encrypted store archive uploaded to Drive",
  live: true,
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
  primaryMetric: "backup_mb",
  unit: "MB",
  async probe(ctx: ImporterContext): Promise<string> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const res = await fetchImpl("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${ctx.credential ?? ""}` },
    });
    if (!res.ok) throw new Error(`Drive about → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const who = (await res.json()) as { user?: { emailAddress?: string } };
    return `Drive reachable as ${who.user?.emailAddress ?? "unknown account"}`;
  },
  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const r = await runDriveBackup({ credential: ctx.credential ?? "", fetchImpl: ctx.fetchImpl });
    return {
      table: { header: ["date", "backup_mb"], rows: [[r.date, String(r.mb)]] },
      meta: { file: r.file, bytes: r.bytes, rotationDeleted: r.rotation.deleted },
    };
  },
};
