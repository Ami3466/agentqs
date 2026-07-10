// The Settings "GitHub or keep local" toggle (record-git.ts) — .gitignore
// shape handling across vintages, and applicability. The privacy rule under
// test: recordInAppRepoEnabled() must report what GIT does (negations present,
// no blanket line), not which release wrote the file — a pre-upgrade enabled
// checkout must read ON so the user can see and disable it.
import fs from "fs";
import os from "os";
import path from "path";
import { recordInAppRepoApplicable, recordInAppRepoEnabled, setRecordInAppRepoEnabled } from "../src/lib/record-git";

delete process.env.AGENTQS_DATA_DIR;
const origCwd = process.cwd();
const origHome = process.env.HOME;
let failures = 0;

function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
}

function inTempRepo(fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-recordgit-"));
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  process.env.HOME = path.join(root, "home");
  process.chdir(root);
  try {
    fn(root);
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const gitignore = (lines: string[]) => fs.writeFileSync(".gitignore", `${lines.join("\n")}\n`);
const lines = () => fs.readFileSync(".gitignore", "utf8").split("\n");

inTempRepo(() => {
  gitignore(["node_modules/", "/data/*", "!/data/record/", "!/data/record/**"]);
  check("pre-upgrade 3-line ENABLED shape reads ON", recordInAppRepoEnabled() === true);

  setRecordInAppRepoEnabled(false);
  check("disabling a pre-upgrade shape lands /data*", lines().includes("/data*"));
  check("disabling removes the negations", !lines().some((l) => l.startsWith("!/data/record")));
  check("disabled reads OFF", recordInAppRepoEnabled() === false);
});

inTempRepo(() => {
  gitignore(["/data/", "node_modules/"]);
  check("pre-upgrade DISABLED shape reads OFF", recordInAppRepoEnabled() === false);
  setRecordInAppRepoEnabled(true);
  check("enabling normalizes to the current shape", lines().includes("/data.*") && lines().includes("!/data/record/**"));
  check("enabled reads ON", recordInAppRepoEnabled() === true);
  check("legacy blanket line removed on write", !lines().includes("/data/"));
});

inTempRepo(() => {
  gitignore(["/data*", "!/data/record/", "!/data/record/**"]);
  check("negations behind a blanket /data* read OFF (git can't re-include)", recordInAppRepoEnabled() === false);
});

inTempRepo(() => {
  gitignore(["/data.nosync/", "/data/*", "!/data/record/", "!/data/record/**"]);
  check("stray data.nosync line does not mask an enabled record", recordInAppRepoEnabled() === true);
});

inTempRepo((root) => {
  fs.mkdirSync(path.join(root, "data", "record"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), "{}");
  check("real ./data store is applicable", recordInAppRepoApplicable() === true);
});

inTempRepo((root) => {
  fs.mkdirSync(path.join(root, "data.nosync", "record"), { recursive: true });
  fs.writeFileSync(path.join(root, "data.nosync", "config.json"), "{}");
  fs.symlinkSync("data.nosync", path.join(root, "data"));
  check("symlinked ./data is NOT applicable (git skips dir symlinks)", recordInAppRepoApplicable() === false);
});

inTempRepo((root) => {
  fs.mkdirSync(path.join(root, "data.nosync", "record"), { recursive: true });
  fs.writeFileSync(path.join(root, "data.nosync", "config.json"), "{}");
  check("store outside ./data is NOT applicable", recordInAppRepoApplicable() === false);
});

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("record-git-test: all green");
