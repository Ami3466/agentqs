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
 * Run: npm run verify:tree
 */
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main(): void {
  const repo = git(["rev-parse", "--show-toplevel"]);
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
