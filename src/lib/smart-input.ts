/**
 * The smart-input contract for the Chat box (Loop 6). One line the user types is
 * routed by its prefix into one of three modes:
 *
 *   plain text  → talk to the mentor (the model / grounded answer)
 *   `>>`        → a memo: appended raw to the inbox, no LLM, no reply
 *   `/`         → a command: /sync · /structure · /new · /mentor
 *
 * Pure data + string helpers only (no fs, no React) so the exact same routing is
 * shared by the client input box and server-side tests — the dispatch can't drift.
 */

export type Mode = "chat" | "memo" | "command";

/** Which mode a raw input line falls into, purely from its prefix. */
export function modeOf(text: string): Mode {
  if (text.startsWith(">>")) return "memo";
  if (text.startsWith("/")) return "command";
  return "chat";
}

export interface Command {
  cmd: string; // includes the leading slash, e.g. "/sync"
  desc: string;
}

export const COMMANDS: Command[] = [
  { cmd: "/sync", desc: "Pull the latest from your connected sources" },
  { cmd: "/structure", desc: "Turn pending inbox items into daily data" },
  { cmd: "/new", desc: "Start a fresh session" },
  { cmd: "/mentor", desc: "Switch the active mentor (e.g. /mentor coach)" },
];

/** The command-palette suggestions for the current input: commands whose name
 *  prefix-matches the first typed token. Empty unless the line is in command mode. */
export function filterCommands(input: string): Command[] {
  if (modeOf(input) !== "command") return [];
  const token = input.split(/\s+/)[0].toLowerCase();
  return COMMANDS.filter((c) => c.cmd.startsWith(token));
}

/** Split a `/command arg1 arg2` line into its (lowercased) command name + args. */
export function parseCommand(raw: string): { cmd: string; args: string[] } {
  const parts = raw.slice(1).trim().split(/\s+/).filter(Boolean);
  return { cmd: (parts[0] ?? "").toLowerCase(), args: parts.slice(1) };
}

/** The verbatim memo text a `>>` line carries (the prefix stripped). */
export function memoText(raw: string): string {
  return raw.replace(/^>>\s*/, "").trim();
}
