import type { FileImporter } from "../file-plugin";
import { chromeImporter } from "./chrome";
import { iphoneImporter } from "./iphone";
import { safariImporter } from "./safari";
import { appleHealthImporter } from "./apple-health";
import { spotifyExportImporter } from "./spotify-export";

/**
 * Tier-2 file importers (Loop 12) — sources that read a local file on your own
 * machine (Chrome/Safari History SQLite, an iPhone backup, the Health app's
 * export.zip). They share the FileImporter contract and the `import:file` CLI /
 * local daemon; a cloud replica gets their data through git, not by reading
 * your disk. iPhone is a stub adapter until its per-domain extraction lands.
 * No reader is imported here eagerly enough to pull `better-sqlite3` into the
 * browser graph — the DB open is a dynamic import inside `read()`, so the
 * Data-tab server page can list these sources cheaply.
 */
export const FILE_IMPORTERS: FileImporter[] = [
  chromeImporter,
  safariImporter,
  iphoneImporter,
  appleHealthImporter,
  // Backfills the SAME `spotify` source the API sync keeps fresh (as Apple Health
  // backfills `health_daily`) — the export is the only place the history exists.
  spotifyExportImporter,
];

export function fileImporterById(id: string): FileImporter | undefined {
  return FILE_IMPORTERS.find((f) => f.id === id);
}
