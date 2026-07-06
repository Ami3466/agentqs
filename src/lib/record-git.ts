import fs from "fs";
import path from "path";

const DATA_IGNORED = "/data/";
const RECORD_ALLOWED = ["/data/*", "!/data/record/", "!/data/record/**"];

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

export function recordInAppRepoEnabled(): boolean {
  const lines = readLines();
  return RECORD_ALLOWED.every((line) => lines.includes(line)) && !lines.includes(DATA_IGNORED);
}

export function setRecordInAppRepoEnabled(enabled: boolean): void {
  const lines = readLines();
  const withoutManaged = lines.filter((line) => !RECORD_ALLOWED.includes(line));

  if (enabled) {
    let inserted = false;
    const next = withoutManaged.flatMap((line) => {
      if (line !== DATA_IGNORED) return [line];
      inserted = true;
      return RECORD_ALLOWED;
    });
    if (!inserted) next.push(...RECORD_ALLOWED);
    writeLines(next);
    return;
  }

  const next = withoutManaged.filter((line) => line !== DATA_IGNORED);
  next.push(DATA_IGNORED);
  writeLines(next);
}
