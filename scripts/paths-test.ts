// dataDir() resolution — the split-store guard. Resolution order under test:
// AGENTQS_DATA_DIR > app-data store > ./data.nosync > ./data, where a dir
// holding record/ (rank 2) outranks a lone config (rank 1) outranks bare (0),
// and earlier candidates win ties. Sync engines (iCloud & co.) evict, rename
// to "X 2" and resurrect deleted dirs — no artifact they leave may ever shadow
// the real store.
import fs from "fs";
import os from "os";
import path from "path";
import { dataDir } from "../src/lib/paths";

delete process.env.AGENTQS_DATA_DIR;
delete process.env.XDG_DATA_HOME;
const origCwd = process.cwd();
const origHome = process.env.HOME;
let failures = 0;

type Spot = "data" | "data.nosync" | "appdata";

function appData(root: string): string {
  // mirrors defaultStoreDir() with HOME pinned inside root
  if (process.platform === "darwin") return path.join(root, "home", "Library", "Application Support", "agentqs");
  if (process.platform === "win32") return path.join(root, "home", "AppData", "Local", "agentqs");
  return path.join(root, "home", ".local", "share", "agentqs");
}

function spotPath(root: string, spot: Spot): string {
  return spot === "appdata" ? appData(root) : path.join(root, spot);
}

const mkStore = (dir: string, parts: Array<"record" | "config">) => {
  fs.mkdirSync(dir, { recursive: true });
  if (parts.includes("record")) fs.mkdirSync(path.join(dir, "record"), { recursive: true });
  if (parts.includes("config")) fs.writeFileSync(path.join(dir, "config.json"), "{}");
};

function scenario(name: string, setup: (root: string) => void, expected: Spot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-paths-"));
  try {
    fs.mkdirSync(path.join(root, "home"), { recursive: true });
    process.env.HOME = path.join(root, "home");
    process.env.LOCALAPPDATA = path.join(root, "home", "AppData", "Local");
    setup(root);
    process.chdir(root);
    const got = dataDir();
    const want = spotPath(root, expected);
    const norm = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
    if (norm(got) === norm(want)) {
      console.log(`ok   ${name}`);
    } else {
      console.error(`FAIL ${name}: expected ${want}, got ${got}`);
      failures++;
    }
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

scenario("nothing initialized anywhere -> app-data (new installs land safe)", () => {}, "appdata");

scenario("app-data store beats checkout-local stores", (root) => {
  mkStore(appData(root), ["record", "config"]);
  mkStore(path.join(root, "data.nosync"), ["record", "config"]);
  mkStore(path.join(root, "data"), ["record", "config"]);
}, "appdata");

scenario("app-data with lone config loses to a data.nosync record", (root) => {
  mkStore(appData(root), ["config"]);
  mkStore(path.join(root, "data.nosync"), ["record", "config"]);
}, "data.nosync");

scenario("legacy ./data.nosync record still resolves (no app-data store)", (root) => {
  mkStore(path.join(root, "data.nosync"), ["record", "config"]);
}, "data.nosync");

scenario("legacy ./data record still resolves", (root) => {
  mkStore(path.join(root, "data"), ["record", "config"]);
}, "data");

scenario("ghost ./data (stray config, no record) never shadows data.nosync", (root) => {
  mkStore(path.join(root, "data"), ["config"]);
  mkStore(path.join(root, "data.nosync"), ["record", "config"]);
}, "data.nosync");

scenario("resurrected full ./data snapshot (record too) loses the tie to data.nosync", (root) => {
  mkStore(path.join(root, "data"), ["record", "config"]);
  mkStore(path.join(root, "data.nosync"), ["record", "config"]);
}, "data.nosync");

scenario("./data symlink to data.nosync -> same store", (root) => {
  mkStore(path.join(root, "data.nosync"), ["record", "config"]);
  fs.symlinkSync("data.nosync", path.join(root, "data"));
}, "data.nosync");

scenario("./data config only, nothing else -> ./data (legacy fresh setup)", (root) => {
  mkStore(path.join(root, "data"), ["config"]);
}, "data");

{
  // env var wins over everything
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-paths-env-"));
  const override = path.join(root, "elsewhere");
  fs.mkdirSync(override, { recursive: true });
  process.env.AGENTQS_DATA_DIR = override;
  const got = dataDir();
  if (path.resolve(got) === path.resolve(override)) console.log("ok   AGENTQS_DATA_DIR override wins");
  else {
    console.error(`FAIL env override: expected ${override}, got ${got}`);
    failures++;
  }
  delete process.env.AGENTQS_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("paths-test: all green");
