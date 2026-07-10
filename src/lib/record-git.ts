import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

/**
 * The Settings → Data choice: keep the record local, or let THIS app checkout
 * track data/record so the user's private fork pushes it to GitHub. Managed by
 * rewriting the checkout's .gitignore between two shapes. Disabled ignores
 * every data* entry (also catches sync-engine artifacts like "data 2" and
 * retired data.migrated-* stores); enabled keeps those ignored but re-includes
 * data/record. Only meaningful while the store actually lives at
 * <checkout>/data — recordInAppRepoApplicable() says whether it does.
 */
const DISABLED_SHAPE = ["/data*"];
const ENABLED_SHAPE = ["/data.*", "/data *", "/data/*", "!/data/record/", "!/data/record/**"];
/** Older checkouts carried these; either toggle write cleans them up. */
const LEGACY_LINES = ["/data", "/data/", "/data.nosync/", "/data.nosync"];
const MANAGED = new Set([...DISABLED_SHAPE, ...ENABLED_SHAPE, ...LEGACY_LINES]);

function gitignorePath(): string {
  return path.join(process.cwd(), ".gitignore");
}

function readLines(): string[] {
  try {
    return fs.readFileSync(gitignorePath(), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function writeLines(lines: string[]): void {
  const text = `${lines.filter((line, i) => line || i < lines.length - 1).join("\n")}\n`;
  fs.writeFileSync(gitignorePath(), text, "utf8");
}

/** The toggle only works while the active store IS <checkout>/data — a store
 *  in app-data (or data.nosync) can't be re-included by this repo's .gitignore. */
export function recordInAppRepoApplicable(): boolean {
  const local = path.join(process.cwd(), "data");
  if (!fs.existsSync(local)) return false;
  try {
    return fs.realpathSync(dataDir()) === fs.realpathSync(local);
  } catch {
    return false;
  }
}

export function recordInAppRepoEnabled(): boolean {
  const lines = readLines();
  const blanket = [...DISABLED_SHAPE, ...LEGACY_LINES].some((line) => lines.includes(line));
  return !blanket && ENABLED_SHAPE.every((line) => lines.includes(line));
}

export function setRecordInAppRepoEnabled(enabled: boolean): void {
  const lines = readLines();
  const shape = enabled ? ENABLED_SHAPE : DISABLED_SHAPE;
  let inserted = false;
  const next = lines.flatMap((line) => {
    if (!MANAGED.has(line)) return [line];
    if (inserted) return [];
    inserted = true;
    return shape;
  });
  if (!inserted) next.push(...shape);
  writeLines(next);
}
