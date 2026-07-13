#!/usr/bin/env tsx
/**
 * Off-site backup proof — drives src/lib/backup.ts end to end, offline:
 *
 *   github → a record whose OWN git history already tracks an oversized file
 *            (the real-life trap: events.jsonl past GitHub's limit) pushes a
 *            snapshot branch to a local bare "GitHub": the snapshot excludes
 *            the oversized file LOUDLY, lands everything else, dedups an
 *            unchanged second run, picks up changes on the third, and never
 *            touches the record repo's own branch.
 *   drive  → archive → AES-256-GCM through a fake stateful Drive (resumable
 *            initiate + PUT + list + delete): the uploaded bytes decrypt +
 *            untar back byte-identical (the oversized file INCLUDED — Drive
 *            covers what GitHub can't), a flipped byte and a wrong passphrase
 *            both fail loudly, rotation deletes past `keep`, and restore
 *            refuses a non-empty destination. `--latest` restores through the
 *            same fake. The plugin's probe proves a credential with NO upload.
 *
 * Deterministic, no network. Run: npm run backup:test
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-backup-"));
process.env.AGENTQS_DATA_DIR = root;

import {
  backupGithub,
  backupStatus,
  restoreArchive,
  restoreIntoStore,
  runDriveBackup,
  setBackupPassphrase,
} from "../src/lib/backup";
import { gdriveBackupPlugin } from "../src/lib/importers/gdrive-backup";
import { writeConfig, readConfig, type AppConfig } from "../src/lib/config";
import type { FetchLike } from "../src/lib/importers/plugin";

let failures = 0;
function check(label: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

async function main() {
  const record = path.join(root, "record");
  fs.mkdirSync(path.join(record, "daily"), { recursive: true });
  fs.writeFileSync(path.join(record, "daily", "steps.csv"), "date,steps\n2026-01-01,10\n");
  fs.writeFileSync(path.join(record, "inbox.jsonl"), `{"id":"a","text":"hi"}\n`);
  // "Oversized" under the test limit, but VALID JSONL — an into-store restore
  // rebuilds the cache from it, so the seed must parse like a real record.
  const eventLines: string[] = [];
  for (let i = 0; i < 1500; i++) {
    eventLines.push(
      JSON.stringify({ id: `seed-${i}`, ts: "2026-01-01T08:00:00Z", source: "seed", title: `event ${i}`, text: `padding ${"x".repeat(160)}` }),
    );
  }
  fs.writeFileSync(path.join(record, "events.jsonl"), `${eventLines.join("\n")}\n`);
  fs.writeFileSync(path.join(record, "old.bak-repair"), "transient repair copy");
  writeConfig({
    username: "t",
    passwordHash: "x",
    sessionSecret: "s",
    theme: "system",
    createdAt: new Date().toISOString(),
  } as AppConfig);

  // The real-life trap: the record repo's own history already tracks the huge file.
  git(record, ["init", "-q", "-b", "main"]);
  git(record, ["add", "-A"]);
  git(record, ["commit", "-q", "-m", "checkpoint"]);
  const ownHead = git(record, ["rev-parse", "main"]);

  console.log("\ngithub snapshot:");
  const bare = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const LIMIT = 100_000;

  const r1 = await backupGithub({ dir: record, remote: bare, sizeLimitBytes: LIMIT });
  check("first snapshot pushed", r1.changed && r1.commit.length === 40);
  check(
    "oversized file excluded + named",
    r1.excluded.length === 1 && r1.excluded[0].path === "events.jsonl",
    r1.excluded.map((e) => e.path).join(","),
  );
  check("result message names the exclusion", r1.message.includes("events.jsonl"));
  const remoteFiles = git(bare, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
  check("remote has the record", remoteFiles.includes("daily/steps.csv") && remoteFiles.includes("inbox.jsonl"));
  check("remote does NOT have the oversized file", !remoteFiles.includes("events.jsonl"));
  check("record's own branch untouched", git(record, ["rev-parse", "main"]) === ownHead);
  check("record worktree/index untouched", git(record, ["status", "--porcelain"]) === "");

  const r2 = await backupGithub({ dir: record, remote: bare, sizeLimitBytes: LIMIT });
  check("unchanged record → no new snapshot", !r2.changed && r2.commit === r1.commit);

  fs.appendFileSync(path.join(record, "daily", "steps.csv"), "2026-01-02,12\n");
  const r3 = await backupGithub({ dir: record, remote: bare, sizeLimitBytes: LIMIT });
  check("changed record → new snapshot on top", r3.changed && r3.commit !== r1.commit);
  check(
    "remote picked up the change",
    git(bare, ["show", "main:daily/steps.csv"]).includes("2026-01-02"),
  );

  console.log("\ndrive archive (fake Drive):");
  setBackupPassphrase({ value: "test-pass-123" });
  const c0 = readConfig()!;
  c0.backup = { ...c0.backup, drive: { keep: 2 } };
  writeConfig(c0);

  // Stateful fake Drive: uploads keyed by name, list newest-first like the API.
  const uploads: { id: string; name: string; createdTime: string; body: Buffer }[] = [];
  let sessions = 0;
  const pendingNames = new Map<string, string>();
  const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
  const fakeDrive = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = decodeURIComponent(String(url));
    if (href.includes("/about")) return json({ user: { emailAddress: "amit@example.com" } });
    if (href.includes("uploadType=resumable")) {
      const meta = JSON.parse(String(init?.body)) as { name: string };
      const session = `https://drive.fake/up/${++sessions}`;
      pendingNames.set(session, meta.name);
      return new Response(null, { status: 200, headers: { Location: session } });
    }
    if (href.startsWith("https://drive.fake/up/")) {
      const name = pendingNames.get(href)!;
      const id = `f${uploads.length + 1}`;
      uploads.unshift({ id, name, createdTime: new Date(2026, 0, uploads.length + 1).toISOString(), body: Buffer.from(init?.body as Uint8Array) });
      return json({ id, name });
    }
    if (href.includes("alt=media")) {
      const id = href.match(/files\/([^?]+)/)?.[1];
      const f = uploads.find((u) => u.id === id)!;
      return new Response(new Uint8Array(f.body), { status: 200 });
    }
    if (href.includes("/files?q=") && href.includes("mimeType=")) return json({ files: [] });
    if (href.includes("/files?q=")) return json({ files: uploads.map(({ id, name, createdTime }) => ({ id, name, createdTime })) });
    if (init?.method === "DELETE") {
      const id = href.match(/files\/([^?]+)/)?.[1];
      const i = uploads.findIndex((u) => u.id === id);
      if (i >= 0) uploads.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (href.match(/\/files\/[^?]+\?fields=/)) {
      return json({ id: href.match(/files\/([^?]+)/)?.[1], trashed: false });
    }
    if (init?.method === "POST" && href.endsWith("/files")) return json({ id: "folder-1" });
    return json({});
  }) as FetchLike;

  const d1 = await runDriveBackup({ credential: "tok", fetchImpl: fakeDrive });
  check("archive uploaded", uploads.length === 1 && uploads[0].name === d1.file, d1.file);
  check("receipt has size", d1.bytes > 0 && d1.mb >= 1);
  check("folder id persisted", readConfig()?.backup?.drive?.folderId === "folder-1");
  check("lastAt/lastFile persisted", Boolean(readConfig()?.backup?.drive?.lastAt) && readConfig()?.backup?.drive?.lastFile === d1.file);

  // Roundtrip: the UPLOADED bytes restore byte-identical, oversized file included.
  const encFile = path.join(root, "downloaded.enc");
  fs.writeFileSync(encFile, uploads[0].body);
  const out1 = path.join(root, "restore-1");
  const rr = await restoreArchive({ file: encFile, out: out1, passphrase: "test-pass-123" });
  check("restore lands record + config.json", rr.members.includes("record") && rr.members.includes("config.json"));
  check(
    "restored files byte-identical (oversized INCLUDED — Drive covers it)",
    fs.readFileSync(path.join(out1, "record", "events.jsonl")).equals(fs.readFileSync(path.join(record, "events.jsonl"))) &&
      fs.readFileSync(path.join(out1, "record", "daily", "steps.csv"), "utf8") ===
        fs.readFileSync(path.join(record, "daily", "steps.csv"), "utf8"),
  );
  check("git history and *.bak-* stay OUT of the archive",
    !fs.existsSync(path.join(out1, "record", ".git")) && !fs.existsSync(path.join(out1, "record", "old.bak-repair")));

  let refusedNonEmpty = false;
  await restoreArchive({ file: encFile, out: out1, passphrase: "test-pass-123" }).catch(() => (refusedNonEmpty = true));
  check("restore refuses a non-empty destination", refusedNonEmpty);

  let wrongPass = false;
  await restoreArchive({ file: encFile, out: path.join(root, "restore-2"), passphrase: "WRONG" }).catch(
    (e) => (wrongPass = /passphrase|corrupt/i.test(e.message)),
  );
  check("wrong passphrase fails loudly", wrongPass);

  const tampered = Buffer.from(uploads[0].body);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  const tamperedFile = path.join(root, "tampered.enc");
  fs.writeFileSync(tamperedFile, tampered);
  let tamperCaught = false;
  await restoreArchive({ file: tamperedFile, out: path.join(root, "restore-3"), passphrase: "test-pass-123" }).catch(
    () => (tamperCaught = true),
  );
  check("a flipped byte fails the whole restore (GCM)", tamperCaught);

  const d2 = await runDriveBackup({ credential: "tok", fetchImpl: fakeDrive });
  const d3 = await runDriveBackup({ credential: "tok", fetchImpl: fakeDrive });
  check("rotation keeps `keep` newest", uploads.length === 2, `${uploads.length} kept`);
  check("rotation reports what it deleted", d3.rotation.deleted.length === 1, d3.rotation.deleted.join(","));
  check("archive names never collide", d1.file !== d2.file && d2.file !== d3.file);

  const out4 = path.join(root, "restore-latest");
  const rl = await restoreArchive({ latest: true, credential: "tok", fetchImpl: fakeDrive, out: out4, passphrase: "test-pass-123" });
  check("--latest restores the newest archive from Drive", rl.archive === d3.file && rl.members.includes("record"));

  console.log("\nrestore into live store (the fresh-instance migration path):");
  const store2 = path.join(root, "store2");
  fs.mkdirSync(path.join(store2, "record", "daily"), { recursive: true });
  fs.writeFileSync(path.join(store2, "record", "daily", "other.csv"), "date,x\n2026-02-02,1\n");
  fs.writeFileSync(path.join(store2, "config.json"), `{"username":"prod-instance"}`);
  const ri = await restoreIntoStore({ file: encFile, dir: store2, passphrase: "test-pass-123" });
  check(
    "archive record replaced the live record",
    fs.readFileSync(path.join(store2, "record", "daily", "steps.csv"), "utf8").includes("2026-01-01"),
  );
  check(
    "previous record RETIRED beside the store, never deleted",
    Boolean(ri.retired) && fs.existsSync(path.join(ri.retired!, "daily", "other.csv")),
    ri.retired ?? "",
  );
  check(
    "instance's own config kept (data moved, not identity)",
    fs.readFileSync(path.join(store2, "config.json"), "utf8") === `{"username":"prod-instance"}`,
  );
  check("cache rebuilt from the restored record", ri.dailyRows > 0 && fs.existsSync(path.join(store2, "agentqs.db")), `${ri.dailyRows} daily rows`);

  console.log("\nplugin contract:");
  const detail = await gdriveBackupPlugin.probe!({ credential: "tok", from: "2026-01-01", to: "2026-01-03", fetchImpl: fakeDrive });
  check("probe proves the credential WITHOUT uploading", detail.includes("amit@example.com") && uploads.length === 2);
  check("plugin connects via OAuth (drive.file)", gdriveBackupPlugin.oauth?.scope.includes("drive.file") === true);
  check("plugin ships a credential guide", (gdriveBackupPlugin.credentialHelp?.steps.length ?? 0) >= 4);

  console.log("\nstatus:");
  const st = backupStatus();
  check("drive status: passphrase set + last run visible", st.drive.passphraseSet && st.drive.lastFile === d3.file);
  check("github status: not configured in this store (test ran with explicit dir)", !st.github.configured);

  let noPassphrase = false;
  const c1 = readConfig()!;
  delete c1.backup?.passphrase;
  writeConfig(c1);
  await runDriveBackup({ credential: "tok", fetchImpl: fakeDrive }).catch((e) => (noPassphrase = /passphrase/.test(e.message)));
  check("no passphrase → loud refusal (never an unencrypted upload)", noPassphrase);

  fs.rmSync(root, { recursive: true, force: true });
  if (failures) {
    console.log(`\n✗ ${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("\n✓ backup: GitHub snapshot (oversized excluded loudly) + encrypted Drive archive (roundtrip, tamper-proof, rotated) + restore.\n");
}

void main();
