#!/usr/bin/env tsx
/**
 * Type-check WHAT GIT WOULD PUSH, not what happens to be on your disk.
 *
 * Every red build in this repo's history has been the same mistake: a new module is
 * created, something imports it, `tsc` and `next build` pass locally because the
 * file is right there — and the commit never `git add`ed it. CI checks out only the
 * tracked tree, the import resolves to nothing, and the image build dies three
 * minutes in with "Module not found: Can't resolve './coverage'".
 *
 * The whole class disappears if the check runs against the tracked tree. This
 * exports HEAD (plus anything currently staged, so it also covers the commit you
 * are about to make) into a temp dir, borrows this checkout's node_modules, and
 * type-checks there. Untracked file → unresolved import → fails here, in seconds,
 * before the push.
 *
 * It also refuses a package.json with a DUPLICATE KEY. JSON keeps the last one and
 * says nothing, so a second `"reset:test"` once silently unplugged the source-reset
 * proof: `npm run reset:test` went green running a different file. Checked in both
 * the tracked tree and the working copy, before the slow type-check.
 *
 * That guard scans raw text, so it PROVES ITSELF first on every run (`selfCheck`):
 * a duplicate key is caught, a clean file passes, and a malformed file — an
 * unterminated string once sent the scan past the end of the text forever — is
 * reported and exits non-zero instead of hanging the pre-push check.
 *
 * Run: npm run verify:tree   (the guard's proof alone: npm run verify:tree:test)
 */
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Every key that appears twice in one object of a JSON text, as `path.key`.
 *  JSON.parse cannot see these — it has already dropped the loser. */
function duplicateJsonKeys(text: string): string[] {
  const dupes: string[] = [];
  const stack: { path: string; keys: Set<string>; array: boolean }[] = [];
  let pending = ""; // the key whose value we are about to read
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      // Never walk off the end: `text[j]` is undefined there, which is also "not a
      // quote", so an unterminated string used to spin this loop forever.
      if (j >= text.length) throw new Error(`unterminated string starting at offset ${i}`);
      const top = stack[stack.length - 1];
      // A string is a key when it sits in an object and a colon follows it.
      if (top && !top.array && /^\s*:/.test(text.slice(j + 1, j + 64))) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) dupes.push(top.path ? `${top.path}.${key}` : key);
        top.keys.add(key);
        pending = key;
      }
      i = j;
    } else if (c === "{" || c === "[") {
      const parent = stack[stack.length - 1];
      const at = parent && !parent.array && pending ? (parent.path ? `${parent.path}.${pending}` : pending) : parent?.path ?? "";
      stack.push({ path: at, keys: new Set(), array: c === "[" });
      pending = "";
    } else if (c === "}" || c === "]") {
      stack.pop();
    }
  }
  return dupes;
}

function assertNoDuplicateKeys(file: string, label: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  let dupes: string[] = [];
  try {
    dupes = duplicateJsonKeys(text);
    JSON.parse(text); // whatever else is wrong with it, say so here rather than in tsc
  } catch (e) {
    console.error(`\nFAIL — ${label} package.json is malformed JSON: ${(e as Error).message}\n`);
    process.exit(1);
  }
  if (!dupes.length) return;
  console.error(
    `\nFAIL — ${label} package.json repeats a key: ${dupes.join(", ")}\n` +
      "JSON keeps only the LAST one, so the earlier entry is unreachable. Rename one.\n",
  );
  process.exit(1);
}

/** The guard checking itself, as CHILD processes with a deadline — the failure this
 *  exists for is a hang, and a hang cannot be asserted from inside the same loop. */
function selfCheck(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-tree-self-"));
  const cases: { name: string; json: string; status: number; says: RegExp }[] = [
    { name: "a clean file passes", json: '{"scripts":{"a":"1","b":"2"},"a":"x \\" y"}', status: 0, says: /^$/ },
    { name: "a duplicate key is refused by name", json: '{"scripts":{"reset:test":"1","x":"2","reset:test":"3"}}', status: 1, says: /repeats a key: scripts\.reset:test/ },
    { name: "an unterminated string is reported, not looped on", json: '{"scripts":{"a":"1","b":"never closed}}', status: 1, says: /malformed JSON: unterminated string starting at offset 24/ },
    { name: "…also when it ends on a backslash", json: '{"a":"x\\', status: 1, says: /malformed JSON: unterminated string starting at offset 5/ },
  ];
  let failed = 0;
  try {
    for (const [n, c] of cases.entries()) {
      const file = path.join(dir, `case-${n}.json`);
      fs.writeFileSync(file, c.json);
      const started = Date.now();
      const r = spawnSync(process.execPath, [...process.execArgv, __filename, "--check-json", file], { encoding: "utf8", timeout: 20_000 });
      const hung = r.error !== undefined || r.signal !== null;
      const ok = !hung && r.status === c.status && c.says.test((r.stderr ?? "").trim());
      if (!ok) {
        failed++;
        console.error(`  ✗ ${c.name} — ${hung ? `did not exit within 20s (${Date.now() - started}ms)` : `exit ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}`}`);
      } else console.log(`  ✓ ${c.name}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed) {
    console.error("\nFAIL — the package.json guard does not pass its own check, so its verdict below would mean nothing.\n");
    process.exit(1);
  }
}

function main(): void {
  const flag = process.argv[2];
  if (flag === "--check-json") return assertNoDuplicateKeys(process.argv[3], "the given");
  console.log("The package.json guard, checking itself…");
  selfCheck();
  if (flag === "--self-check") return;
  const repo = git(["rev-parse", "--show-toplevel"]);
  assertNoDuplicateKeys(path.join(repo, "package.json"), "the working copy's");
  const modules = path.join(repo, "node_modules");
  if (!fs.existsSync(modules)) {
    console.error("node_modules is missing — run `npm ci` first.");
    process.exit(1);
  }

  // Staged changes included: this is the tree the NEXT commit will have, which is
  // the one worth checking. Falls back to HEAD when nothing is staged.
  const tree = git(["write-tree"]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-tree-"));
  try {
    const tar = path.join(out, "tree.tar");
    fs.writeFileSync(tar, execFileSync("git", ["archive", "--format=tar", tree], { cwd: repo, maxBuffer: 1 << 30 }));
    execFileSync("tar", ["-xf", tar, "-C", out]);
    fs.rmSync(tar);
    assertNoDuplicateKeys(path.join(out, "package.json"), "the tracked tree's");
    fs.symlinkSync(modules, path.join(out, "node_modules"), "junction");

    console.log(`Type-checking the tracked tree (${tree.slice(0, 12)}) in ${out}…`);
    const res = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsc", "--noEmit", "-p", path.join(out, "tsconfig.json")],
      { cwd: out, stdio: "inherit" },
    );
    if (res.status !== 0) {
      console.error(
        "\nThe tracked tree does not type-check. If the errors name a module that exists locally,\n" +
          "it is untracked — `git add` it. This is exactly what breaks CI.\n",
      );
      process.exit(res.status ?? 1);
    }
    console.log("\nPASS — everything the push would contain resolves and type-checks.\n");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

main();
