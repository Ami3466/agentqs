import { netFetch, type ImporterContext, type ImporterPlugin, type ImporterResult } from "./plugin";

/**
 * Google Drive raw-import — a READ-ON-REQUEST data source, not a pipeline source
 * and not a backup. Like `gdrive_backup`, it rides the importer-plugin contract
 * for ONE thing only: the credential machinery (the OAuth dance, token refresh,
 * `source authorize`, `source test`). Everything else it deliberately does NOT do
 * — it never auto-syncs, never lands a row in the record, never appears in the
 * Pipeline (`credentialOnly` keeps it out of SOURCE_PLUGINS). Its brain is
 * src/lib/drive-import.ts (`listDriveFolder` / `pullDriveFile`), reached from the
 * `drive` CLI/MCP/API faces; its own face is Settings → Data.
 *
 * Why its OWN grant and not the backup's: backup uses `drive.file` (the app sees
 * only files it created), which cannot read a file YOU dropped in a folder. Reading
 * arbitrary files needs `drive.readonly`, so this carries a separate grant under
 * `drive_import` and asks for its own consent.
 */
export const driveImportPlugin: ImporterPlugin = {
  id: "drive_import",
  name: "Google Drive import",
  detail: "read raw files from a Drive folder on request",
  live: true,
  credentialOnly: true,
  requiresCredential: true,
  credentialLabel: "OAuth access token",
  credentialPlaceholder: "ya29.… (OAuth access token)",
  credentialHelp: {
    url: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "In Google Cloud Console, enable the Google Drive API (reuse the project you made for Drive backup).",
      "On the OAuth consent screen, add the `.../auth/drive.readonly` scope and your own account as a test user.",
      "Credentials → OAuth client ID → Web application, with the Redirect URI shown here (the same client works for backup + import).",
      "Paste the Client ID and Client Secret here and press Authorize — read access is enough; nothing is written to your Drive.",
      "Then Settings → Data → Drive import → pick the folder agentqs may read.",
    ],
  },
  oauth: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    tokenAuth: "body",
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  async probe(ctx: ImporterContext): Promise<string> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const res = await netFetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
      { headers: { Authorization: `Bearer ${ctx.credential ?? ""}` } },
      fetchImpl,
    );
    if (!res.ok) throw new Error(`Drive about → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const who = (await res.json()) as { user?: { emailAddress?: string } };
    return `Drive readable as ${who.user?.emailAddress ?? "unknown account"}`;
  },
  /** Credential-only: a folder is READ on request (`agentqs drive pull`), never
   *  synced into the record. The throw is the guard rail — no path may quietly land
   *  raw-file dumps in the record as if they were captured data. */
  async fetch(): Promise<ImporterResult> {
    throw new Error(
      "Google Drive import is read-on-request, not a synced source — run `agentqs drive list` / " +
        '`agentqs drive pull <file>` (API: GET /api/drive/list, POST /api/drive/pull).',
    );
  },
};
