// Store doctor + migrate-store, against temp dirs only. Covers: sync-domain
// detection (path markers + .nosync exemption), conflict-twin detection, split
// stores, and a full migrate (hash-verified copy, source retired with .nosync
// kept, scheduler plist re-pointed, resolution flips to the new location).
import fs from "fs";
import os from "os";
import path from "path";
import { dataDir } from "../src/lib/paths";
import { doctorReport, migrateStore, syncDomainOf } from "../src/lib/store-doctor";

delete process.env.AGENTQS_DATA_DIR;
delete process.env.XDG_DATA_HOME;
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

const mkStore = (dir: string) => {
  fs.mkdirSync(path.join(dir, "record", "daily"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ username: "t" }));
  fs.writeFileSync(path.join(dir, "record", "daily", "mood.csv"), "date,mood\n2026-01-01,7\n");
  fs.writeFileSync(path.join(dir, "record", "inbox.jsonl"), "");
  // the record's own git repo must travel with it
  fs.mkdirSync(path.join(dir, "record", ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "record", ".git", "HEAD"), "ref: refs/heads/main\n");
};

// ---- sync-domain detection --------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-doctor-"));
  const inDropbox = path.join(root, "Dropbox", "store");
  const exempt = path.join(root, "Dropbox", "store.nosync");
  fs.mkdirSync(inDropbox, { recursive: true });
  fs.mkdirSync(exempt, { recursive: true });
  check("detects a Dropbox path", syncDomainOf(inDropbox) === "Dropbox");
  check("plain temp path is domain-free", syncDomainOf(path.join(root, "plain")) === null);

  mkStore(inDropbox);
  const bad = doctorReport(inDropbox);
  check("store in a synced folder is unsafe", !bad.safe);
  check("location check is 'bad'", bad.checks.find((c) => c.id === "location")?.severity === "bad");

  mkStore(exempt);
  const warned = doctorReport(exempt);
  check(".nosync store inside a domain is safe-with-warning", warned.safe);
  check("location check is 'warn'", warned.checks.find((c) => c.id === "location")?.severity === "warn");
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- conflict twins + split store -------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-doctor-"));
  process.env.HOME = path.join(root, "home");
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  process.chdir(root);
  try {
    const store = path.join(root, "data.nosync");
    mkStore(store);
    fs.writeFileSync(path.join(store, "record", "daily", "mood 2.csv"), "date,mood\n");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "config.json"), "{}"); // ghost

    const rep = doctorReport(dataDir());
    check("conflict twin flagged", rep.checks.find((c) => c.id === "conflicts")?.severity === "warn");
    check("twin path named", Boolean(rep.checks.find((c) => c.id === "conflicts")?.detail.includes("mood 2.csv")));
    check("split store flagged (ghost ./data visible)", rep.checks.find((c) => c.id === "split")?.severity === "warn");
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- migrate-store ------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentqs-migrate-"));
  process.env.HOME = path.join(root, "home");
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  process.chdir(root);
  try {
    const from = path.join(root, "data.nosync");
    mkStore(from);
    const plist = path.join(root, "com.agentqs.autosync.plist");
    fs.writeFileSync(plist, `<plist><string>AGENTQS_DATA_DIR=${from}</string></plist>`);

    const dry = migrateStore({ dryRun: true, plistPath: plist, skipCrontab: true });
    check("dry run reports files", dry.dryRun && dry.files >= 4);
    check("dry run touches nothing", fs.existsSync(from) && !fs.existsSync(dry.to));

    const r = migrateStore({ plistPath: plist, reloadLaunchd: false, skipCrontab: true });
    check("migration verified", r.verified);
    check("record file arrived intact", fs.readFileSync(path.join(r.to, "record", "daily", "mood.csv"), "utf8").includes("2026-01-01,7"));
    check("record .git traveled", fs.existsSync(path.join(r.to, "record", ".git", "HEAD")));
    check("source retired", !fs.existsSync(from) && Boolean(r.retiredTo) && fs.existsSync(r.retiredTo as string));
    check("retired name keeps .nosync", (r.retiredTo ?? "").endsWith(".nosync"));
    check("plist re-pointed", fs.readFileSync(plist, "utf8").includes(r.to) && !fs.readFileSync(plist, "utf8").includes(`=${from}<`));
    check("resolution now finds the new store", fs.realpathSync(dataDir()) === fs.realpathSync(r.to));

    let threw = "";
    try {
      migrateStore({ plistPath: plist, reloadLaunchd: false, skipCrontab: true });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check("second migrate refuses (already at target)", threw.includes("already"));
  } finally {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("store-doctor-test: all green");
