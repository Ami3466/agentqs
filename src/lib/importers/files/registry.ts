import type { FileImporter } from "../file-plugin";
import { chromeImporter } from "./chrome";
import { firefoxImporter } from "./firefox";
import { safariImporter } from "./safari";
import { iphoneImporter } from "./iphone";
import { imessageImporter } from "./imessage";
import { appleHealthImporter } from "./apple-health";
import { owntracksImporter } from "./owntracks";

/**
 * Tier-2/3 file importers — sources that read a local file on your own machine
 * (browser-history SQLite, an iPhone backup, Messages chat.db, an Apple Health
 * export, an OwnTracks location log). They share the FileImporter contract and the
 * `import:file` CLI / local daemon; a cloud replica gets their data through git,
 * not by reading your disk. iPhone is a stub adapter until its per-domain
 * extraction lands. None is imported eagerly enough to pull `better-sqlite3` into
 * the browser graph — each DB open is a dynamic import inside `read()`, so the
 * Data-tab server page can list these sources cheaply.
 */
export const FILE_IMPORTERS: FileImporter[] = [
  chromeImporter,
  firefoxImporter,
  safariImporter,
  iphoneImporter,
  imessageImporter,
  appleHealthImporter,
  owntracksImporter,
];

export function fileImporterById(id: string): FileImporter | undefined {
  return FILE_IMPORTERS.find((f) => f.id === id);
}
