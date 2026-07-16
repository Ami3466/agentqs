#!/usr/bin/env tsx
/**
 * Drive-import proof — drives src/lib/drive-import.ts + its cli-core faces end to
 * end, offline, against a fake stateful Google Drive:
 *
 *   lib   → listDriveFolder pages a folder to its manifest (files + a subfolder,
 *           folders flagged); resolveDriveFile matches by id, exact name, unique
 *           substring, and reports ambiguous / not-found; pullDriveFile returns a
 *           text file's bytes, EXPORTS a Google Doc to plain text, returns a
 *           described stub for a binary (no bytes inlined), and REFUSES an oversize
 *           file with a note instead of clipping it.
 *   faces → through cli-core with a seeded drive.readonly grant + a stubbed global
 *           fetch: driveList lists the configured folder, drivePull resolves a name
 *           to content, and a missing grant fails with a "connect it" message.
 *
 * Also pins the MODEL: Drive import is read-on-request, NOT a source. It never
 * appears in the Pipeline sources list, its fetch() throws, and it refuses to be
 * synced or scheduled as a source.
 *
 * Deterministic, no network. Run: npm run driveimport:test
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-driveimport-"));
process.env.AGENTQS_DATA_DIR = root;

import {
  driveImportAbout,
  listDriveFolder,
  resolveDriveFile,
  pullDriveFile,
  setDriveImportFolder,
  driveImportConfig,
  MAX_PULL_BYTES,
  type DriveFileEntry,
} from "../src/lib/drive-import";
import { driveImportPlugin } from "../src/lib/importers/drive-import";
import { PLUGINS, SOURCE_PLUGINS, pluginById } from "../src/lib/importers/registry";
import { driveList, drivePull, driveImportStatus, syncSource, setInterval as setSourceInterval } from "../src/lib/cli-core";
import { writeConfig, readConfig, type AppConfig } from "../src/lib/config";
import type { FetchLike } from "../src/lib/importers/plugin";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
async function throws(label: string, fn: () => unknown | Promise<unknown>, match?: string) {
  try {
    await fn();
    check(label, false, "did not throw");
  } catch (e) {
    const msg = (e as Error).message;
    check(label, !match || msg.includes(match), match ? msg : "");
  }
}

const TOKEN = "ya29.fake-access-token";
const FOLDER = "FOLDER_ID_1";
const BIG = "X".repeat(MAX_PULL_BYTES + 10);

/** The folder's contents: two readable files, a Google Doc, a binary, an oversize
 *  file, and a subfolder. */
const FILES: Record<string, { name: string; mimeType: string; size?: number; body?: string; export?: string }> = {
  f_txt: { name: "notes.txt", mimeType: "text/plain", size: 15, body: "hello raw world" },
  f_eml: { name: "letter.eml", mimeType: "message/rfc822", size: 20, body: "Subject: hi\n\nbody" },
  f_doc: { name: "meeting.gdoc", mimeType: "application/vnd.google-apps.document", export: "exported doc body" },
  f_png: { name: "photo.png", mimeType: "image/png", size: 2048 },
  f_big: { name: "dump.txt", mimeType: "text/plain", size: BIG.length, body: BIG },
  f_sub: { name: "archive", mimeType: "application/vnd.google-apps.folder" },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A stateful fake Drive over the v3 REST surface the lib uses. */
const fakeDrive: FetchLike = (async (input: string | URL) => {
  const url = new URL(String(input));
  const p = url.pathname;
  if (p.endsWith("/drive/v3/about")) return json({ user: { emailAddress: "me@example.com" } });

  // export: /files/{id}/export
  const exp = p.match(/\/files\/([^/]+)\/export$/);
  if (exp) {
    const f = FILES[decodeURIComponent(exp[1])];
    return new Response(f?.export ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  // media or metadata: /files/{id}
  const one = p.match(/\/files\/([^/]+)$/);
  if (one && url.searchParams.get("alt") === "media") {
    const f = FILES[decodeURIComponent(one[1])];
    return new Response(f?.body ?? "", { status: 200, headers: { "Content-Type": f?.mimeType ?? "text/plain" } });
  }
  if (one) {
    const id = decodeURIComponent(one[1]);
    const f = FILES[id];
    if (!f) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    return json({ id, name: f.name, mimeType: f.mimeType, size: f.size != null ? String(f.size) : undefined });
  }

  // list: /files?q=...
  if (p.endsWith("/drive/v3/files")) {
    const q = url.searchParams.get("q") ?? "";
    const inFolder = q.includes(`'${FOLDER}' in parents`);
    const foldersOnly = q.includes("mimeType='application/vnd.google-apps.folder'") && !inFolder;
    const entries = Object.entries(FILES)
      .filter(([, f]) => (foldersOnly ? f.mimeType === "application/vnd.google-apps.folder" : true))
      .map(([id, f]) => ({
        id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: "2026-07-01T00:00:00Z",
        size: f.size != null ? String(f.size) : undefined,
      }));
    return json({ files: entries }); // one page, no nextPageToken
  }
  throw new Error(`fake Drive: unexpected ${p}`);
}) as unknown as FetchLike;

async function main() {
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: "2026-07-01T00:00:00.000Z",
  } as AppConfig);

  console.log("\nlib — list & resolve:");
  const entries = await listDriveFolder(TOKEN, FOLDER, fakeDrive);
  check("lists every entry", entries.length === Object.keys(FILES).length, String(entries.length));
  const sub = entries.find((e) => e.id === "f_sub");
  check("subfolder flagged isFolder", Boolean(sub?.isFolder));
  const txt = entries.find((e) => e.id === "f_txt");
  check("file size parsed to number", txt?.size === 15, String(txt?.size));

  const byId = resolveDriveFile(entries, "f_doc");
  check("resolve by id", "file" in byId && byId.file.id === "f_doc");
  const byName = resolveDriveFile(entries, "notes.txt");
  check("resolve by exact name", "file" in byName && byName.file.id === "f_txt");
  const bySub = resolveDriveFile(entries, "photo");
  check("resolve by unique substring", "file" in bySub && bySub.file.id === "f_png");
  const missing = resolveDriveFile(entries, "nope-not-here");
  check("not-found → candidates (empty)", "candidates" in missing && missing.candidates.length === 0);

  console.log("\nlib — pull:");
  const about = await driveImportAbout(TOKEN, fakeDrive);
  check("about names the account", about === "me@example.com", about);

  const pTxt = await pullDriveFile(TOKEN, "f_txt", fakeDrive, txt);
  check("text file → content", pTxt.text === "hello raw world", pTxt.text);

  const pEml = await pullDriveFile(TOKEN, "f_eml", fakeDrive);
  check("eml pulled as text (metadata self-resolved)", pEml.text?.startsWith("Subject:") === true);

  const pDoc = await pullDriveFile(TOKEN, "f_doc", fakeDrive);
  check("google doc EXPORTED to text", pDoc.text === "exported doc body", pDoc.text);

  const pPng = await pullDriveFile(TOKEN, "f_png", fakeDrive);
  check("binary → stub, no bytes inlined", pPng.binary === true && pPng.text === undefined, pPng.note);

  const pBig = await pullDriveFile(TOKEN, "f_big", fakeDrive);
  check("oversize REFUSED with a note, not clipped", pBig.truncated === true && pBig.text === undefined, pBig.note);

  console.log("\nmodel — read-on-request, NOT a source:");
  check("registered in PLUGINS", Boolean(pluginById("drive_import")));
  check("EXCLUDED from the pipeline sources", !SOURCE_PLUGINS.some((p) => p.id === "drive_import"));
  check("in PLUGINS (for its OAuth machinery)", PLUGINS.some((p) => p.id === "drive_import"));
  await throws("plugin.fetch() throws", () => driveImportPlugin.fetch({ from: "", to: "" }), "read-on-request");
  await throws("syncSource refuses it", () => syncSource({ id: "drive_import" }), "read-on-request");
  await throws("setInterval refuses it", () => setSourceInterval("drive_import", "daily"), "read-on-request");

  console.log("\nconfig — folder set/clear:");
  setDriveImportFolder(FOLDER, "Raw dump");
  check("folder persists", driveImportConfig().folderId === FOLDER && driveImportConfig().folderName === "Raw dump");
  setDriveImportFolder("");
  check("empty id clears the folder", driveImportConfig().folderId === undefined);

  console.log("\nfaces — cli-core over a seeded grant + stubbed global fetch:");
  // Not connected yet: pull must tell the user to connect, not crash cryptically.
  await throws("drivePull with no grant → connect message", () => drivePull("notes.txt"), "isn't connected");
  const disc = driveImportStatus();
  check("status: not connected before a grant", disc.connected === false);

  // Seed a healthy grant (future expiry, no refresh → no token call) and the folder.
  const cfg = readConfig() as AppConfig;
  cfg.sourceOAuth = {
    drive_import: { accessToken: TOKEN, expiresAt: "2999-01-01T00:00:00.000Z" },
  };
  cfg.driveImport = { folderId: FOLDER, folderName: "Raw dump" };
  writeConfig(cfg);

  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeDrive as typeof fetch;
  try {
    const status2 = driveImportStatus();
    check("status: connected + folder after grant", status2.connected === true && status2.folderId === FOLDER);
    const listed = await driveList();
    check("driveList → configured folder manifest", listed.count === Object.keys(FILES).length && listed.folderId === FOLDER);
    const pulled = await drivePull("notes.txt");
    check("drivePull resolves name → content", (pulled as { text?: string }).text === "hello raw world");
    await throws("drivePull ambiguous name reports candidates", () => drivePull("txt"), "ambiguous");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures ? `✗ ${failures} failing` : "✓ all drive-import checks passed"}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
