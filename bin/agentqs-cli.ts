/**
 * agentqs — the CLI-first face of the whole app.
 *
 * Every capability the GUI has is here and, through the same core (src/lib/cli-core)
 * and the MCP server (`serve --mcp`), reachable from Claude Code: import a file,
 * connect a source, schedule and run syncs, add/edit a mentor, rebuild, query, chat.
 * The web app and the JSON API call the identical core — one brain, three faces.
 *
 * Run:  npm run cli -- <command>        (dev)
 *       agentqs <command>               (after `npm link`)
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import * as core from "../src/lib/cli-core";

const program = new Command();

program
  .name("agentqs")
  .description("Your private life-record + grounded mentor — from the terminal.")
  .version("0.1.0");

/** Print a result as pretty JSON (--json) or a compact human line. */
function out(data: unknown, human?: (d: any) => string): void {
  if (program.opts().json || !human) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(human(data) + "\n");
  }
}

function die(e: unknown): never {
  process.stderr.write(`agentqs: ${(e as Error).message}\n`);
  process.exit(1);
}

program.option("--json", "output raw JSON");

// ---- chat -----------------------------------------------------------------
program
  .command("chat <message...>")
  .description("ask the grounded mentor a question")
  .option("-s, --skill <id>", "persona: mentor | therapist | coach | <custom>")
  .action(async (words: string[], opts: { skill?: string }) => {
    try {
      const r = await core.chat({ message: words.join(" "), skill: opts.skill });
      out(r, (d) => {
        const tag = d.grounded ? `\n[grounded · ${d.sources.join(", ") || "record"}]` : "";
        return d.text + tag;
      });
    } catch (e) {
      die(e);
    }
  });

// ---- query ----------------------------------------------------------------
program
  .command("query <sql...>")
  .description("read-only SQL over the cache (daily / raw_inbox / sessions)")
  .option("-l, --limit <n>", "row cap", (v) => parseInt(v, 10))
  .action((words: string[], opts: { limit?: number }) => {
    try {
      const r = core.query(words.join(" "), opts.limit);
      out(r, (d) => (d.rows.length ? table(d.columns, d.rows) : "(0 rows)"));
    } catch (e) {
      die(e);
    }
  });

// ---- journal --------------------------------------------------------------
program
  .command("journal")
  .description("your daily record, newest first")
  .option("-l, --limit <n>", "days to show", (v) => parseInt(v, 10), 14)
  .option("-s, --source <id>", "only this source's metrics")
  .option("--table", "wide table view")
  .action((opts: { limit: number; source?: string; table?: boolean }) => {
    try {
      const r = core.journal({ limit: opts.limit, source: opts.source });
      out(r, (d) => journalHuman(d, Boolean(opts.table)));
    } catch (e) {
      die(e);
    }
  });

// ---- sources + sync -------------------------------------------------------
program
  .command("sources")
  .description("list every data source and its sync state")
  .action(() => {
    try {
      out(core.sources(), (rows: any[]) =>
        rows
          .map(
            (s) =>
              `${s.connected ? "●" : "○"} ${s.id.padEnd(12)} ${s.kind.padEnd(6)} ${String(s.interval).padEnd(7)} ${
                s.stale ? "stale" : s.due ? "due" : ""
              }`.trimEnd(),
          )
          .join("\n"),
      );
    } catch (e) {
      die(e);
    }
  });

program
  .command("sync [source]")
  .description("run an API source now (omit source to sync all connected)")
  .option("--source <id>", "source id (alternative to the positional arg)")
  .option("-c, --credential <c>", "API key / token for this run")
  .option("-d, --days <n>", "trailing window", (v) => parseInt(v, 10))
  .option("--fixture <file>", "offline: JSON body to feed the importer")
  .action(async (positional: string | undefined, opts: { source?: string; credential?: string; days?: number; fixture?: string }) => {
    const source = positional ?? opts.source;
    try {
      const r = source
        ? await core.syncSource({ id: source, credential: opts.credential, days: opts.days, fixture: opts.fixture })
        : await core.syncAll(opts.days);
      out(r, (d) =>
        source
          ? `Synced ${d.name}: ${d.days} days, ${d.cells} cells → ${d.dailyRows} daily rows.`
          : `Synced ${d.synced.length}, skipped ${d.skipped.length}.`,
      );
    } catch (e) {
      die(e);
    }
  });

// ---- source subcommands: connect / interval / file ------------------------
const source = program.command("source").description("manage sources (connect, schedule, file import)");

source
  .command("connect <id> <credential>")
  .description("save an API source's credential")
  .action((id: string, credential: string) => {
    try {
      out(core.connectSource(id, credential), (d) => `Connected ${d.id}.`);
    } catch (e) {
      die(e);
    }
  });

source
  .command("interval <id> <interval>")
  .description("schedule an automated import: off | hourly | daily | weekly")
  .action((id: string, interval: string) => {
    try {
      out(core.setInterval(id, interval), (d) => `${d.id} → ${d.interval}.`);
    } catch (e) {
      die(e);
    }
  });

source
  .command("remove <id>")
  .alias("disconnect")
  .description("remove an automated import: drop its data, credential + schedule")
  .action((id: string) => {
    try {
      out(core.disconnectSource(id), (d) => `Removed ${d.id} → ${d.dailyRows} daily rows.`);
    } catch (e) {
      die(e);
    }
  });

source
  .command("file <id>")
  .description("import a Tier-2 local file source: chrome | iphone")
  .option("-p, --path <file>", "explicit file/backup path")
  .option("-d, --days <n>", "trailing window", (v) => parseInt(v, 10))
  .action(async (id: string, opts: { path?: string; days?: number }) => {
    try {
      const r = await core.syncFileSource({ id, path: opts.path, days: opts.days });
      out(r, (d) => `Imported ${d.name}: ${d.days} days, ${d.cells} cells → ${d.dailyRows} daily rows.`);
    } catch (e) {
      die(e);
    }
  });

// ---- automation (browser-driven imports for sources with no API) ----------
const automation = program
  .command("automation")
  .description("browser-driven imports for sources with no API (Playwright)");

automation
  .command("list")
  .description("list your automation recipes + last-run status")
  .action(() => {
    try {
      out(core.automations(), (rows: any[]) =>
        rows.length
          ? rows
              .map(
                (a) =>
                  `${a.lastStatus === "error" ? "✗" : a.lastStatus === "ok" ? "●" : "○"} ${a.id.padEnd(16)} ${a.name}  ${a.url}`,
              )
              .join("\n")
          : "(no automations — add one with `agentqs automation add`)",
      );
    } catch (e) {
      die(e);
    }
  });

automation
  .command("add <name>")
  .description("create/update an automation: point it at a site with no API")
  .requiredOption("--url <url>", "start URL (https://…)")
  .option("--id <id>", "explicit id (default: slug of name)")
  .option("--cred-type <t>", "userpass | token | none", "none")
  .option("--username <u>", "login username / email")
  .option("--password <p>", "login password")
  .option("--token <t>", "bearer/session token")
  .option("--steps <json>", "recorded steps as a JSON array")
  .option("--table <selector>", "shortcut: a single extractTable step on this selector")
  .action((name: string, opts: any) => {
    try {
      let steps: any[] | undefined;
      if (opts.steps) steps = JSON.parse(opts.steps);
      else if (opts.table) steps = [{ type: "extractTable", selector: opts.table }];
      out(
        core.automationSave({
          name,
          url: opts.url,
          id: opts.id,
          credType: opts.credType,
          steps,
          username: opts.username,
          password: opts.password,
          token: opts.token,
        }),
        (d) => `Saved automation "${d.id}" (${d.steps.length} steps). Run it: agentqs automation run ${d.id}`,
      );
    } catch (e) {
      die(e);
    }
  });

automation
  .command("run <id>")
  .description("replay an automation now (records the import; --headed to watch)")
  .option("--headed", "open a visible browser (local; e.g. to solve a login)")
  .action(async (id: string, opts: { headed?: boolean }) => {
    try {
      const r = await core.automationRun({ id, headed: opts.headed });
      out(r, (d) =>
        d.landed === "daily"
          ? `Recorded ${d.name}: ${d.rows} cells → ${d.dailyRows} daily rows (${d.metrics.join(", ")}).`
          : `Recorded ${d.name}: ${d.rows} rows landed raw in the inbox — run \`agentqs structure\`.`,
      );
    } catch (e) {
      die(e);
    }
  });

automation
  .command("schedule <id> <interval>")
  .description("set the cron cadence: off | hourly | daily | weekly")
  .action((id: string, interval: string) => {
    try {
      out(core.setInterval(id, interval), (d) => `${d.id} → ${d.interval}.`);
    } catch (e) {
      die(e);
    }
  });

automation
  .command("remove <id>")
  .description("delete an automation (recipe, secrets, data, schedule)")
  .action((id: string) => {
    try {
      out(core.automationRemove(id), (d) => `Removed automation ${d.id}.`);
    } catch (e) {
      die(e);
    }
  });

// ---- import (escape hatch) + structure ------------------------------------
program
  .command("import <file>")
  .description("import any file into the record (CSV structures instantly)")
  .option("-n, --name <source>", "source name for the daily table")
  .action((file: string, opts: { name?: string }) => {
    try {
      out(core.importRaw({ file, name: opts.name }), (d) => d.note);
    } catch (e) {
      die(e);
    }
  });

program
  .command("structure")
  .description("turn pending inbox captures into daily rows")
  .option("--id <id>", "structure one item")
  .action(async (opts: { id?: string }) => {
    try {
      const r = await core.structure({ id: opts.id });
      out(r, (d) => (d.ok ? `Structured ${d.structured}; ${d.pending} still pending.` : d.error));
    } catch (e) {
      die(e);
    }
  });

// ---- config ---------------------------------------------------------------
const config = program.command("config").description("provider, model, key, theme");
config
  .command("list")
  .description("show current settings")
  .action(() => out(core.configList(), (d) => `provider=${d.provider} model=${d.model} key=${d.key} theme=${d.theme}`));
config
  .command("get <key>")
  .description("read one setting")
  .action((key: string) => {
    try {
      out(core.configGet(key), (v) => String(v));
    } catch (e) {
      die(e);
    }
  });
config
  .command("set <key> <value>")
  .description("set: provider | model | key | theme | username")
  .action((key: string, value: string) => {
    try {
      out(core.configSet(key, value), (d) => `${d.key} = ${d.value}`);
    } catch (e) {
      die(e);
    }
  });

// ---- skills (mentors) -----------------------------------------------------
const skill = program.command("skill").description("add / edit / remove mentors");
skill
  .command("list")
  .description("list built-in + custom mentors")
  .action(() =>
    out(core.skillsList(), (rows: any[]) =>
      rows.map((s) => `${s.builtin ? "·" : "+"} ${s.id.padEnd(14)} ${s.name}`).join("\n"),
    ),
  );
skill
  .command("add <name>")
  .description("add a custom mentor")
  .requiredOption("--system <prompt>", "the persona's system prompt")
  .option("--id <id>", "explicit id (default: slug of name)")
  .option("--blurb <text>", "one-line description")
  .action((name: string, opts: { system: string; id?: string; blurb?: string }) => {
    try {
      out(core.skillUpsert({ name, system: opts.system, id: opts.id, blurb: opts.blurb }), (d) =>
        `${d.created ? "Added" : "Updated"} mentor "${d.skill.id}".`,
      );
    } catch (e) {
      die(e);
    }
  });
skill
  .command("edit <id>")
  .description("edit a custom mentor")
  .option("--name <name>", "new name")
  .option("--system <prompt>", "new system prompt")
  .option("--blurb <text>", "new blurb")
  .action((id: string, opts: { name?: string; system?: string; blurb?: string }) => {
    try {
      const existing = core.skillsList().find((s) => s.id === id);
      if (!existing) die(new Error(`No mentor "${id}".`));
      out(
        core.skillUpsert({
          id,
          name: opts.name ?? existing!.name,
          system: opts.system ?? existing!.system,
          blurb: opts.blurb ?? existing!.blurb,
        }),
        (d) => `Updated mentor "${d.skill.id}".`,
      );
    } catch (e) {
      die(e);
    }
  });
skill
  .command("remove <id>")
  .description("remove a custom mentor")
  .action((id: string) => {
    try {
      out(core.skillRemove(id), (d) => `Removed "${d.removed}".`);
    } catch (e) {
      die(e);
    }
  });

// ---- rebuild --------------------------------------------------------------
program
  .command("rebuild")
  .description("rebuild the SQLite cache from the record")
  .option("--verify", "assert determinism (two rebuilds identical)")
  .action((opts: { verify?: boolean }) => {
    try {
      out(core.rebuildCache({ verify: opts.verify }), (d) =>
        `Rebuilt: ${d.daily} daily rows, ${d.inbox} inbox, ${d.sessions} sessions${
          "verified" in d ? ` — verify ${d.verified ? "OK" : "FAILED"}` : ""
        }.`,
      );
    } catch (e) {
      die(e);
    }
  });

// ---- serve (web + MCP) ----------------------------------------------------
program
  .command("serve")
  .description("run the web app, or the MCP server for Claude Code")
  .option("--mcp", "start the MCP server on stdio (for Claude Code)")
  .option("-p, --port <n>", "web port", "3000")
  .action(async (opts: { mcp?: boolean; port: string }) => {
    if (opts.mcp) {
      const { startMcpServer } = await import("./mcp");
      await startMcpServer();
      return; // stays alive on stdio
    }
    const here = path.dirname(fileURLToPath(import.meta.url));
    const nextBin = path.join(here, "..", "node_modules", ".bin", "next");
    const child = spawn(nextBin, ["start", "-p", opts.port], { stdio: "inherit", cwd: path.join(here, "..") });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// ---- helpers --------------------------------------------------------------
function table(cols: string[], rows: Record<string, unknown>[]): string {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join("\n");
}

function journalHuman(d: any, wide: boolean): string {
  if (!d.days.length) return "(no days yet — import a source first)";
  if (wide) {
    const cols = ["date", ...d.metrics.map((m: any) => m.key)];
    const rows = d.days.map((day: any) => {
      const r: Record<string, string> = { date: day.date };
      for (const m of d.metrics) r[m.key] = day.values[m.key]?.text ?? "";
      return r;
    });
    return table(cols, rows);
  }
  return d.days
    .map((day: any) => {
      const vals = d.metrics
        .map((m: any) => (day.values[m.key] ? `${m.metric}=${day.values[m.key].text}` : null))
        .filter(Boolean)
        .join(" ");
      const memo = day.memos.length ? `  +${day.memos.length} memo` : "";
      const ses = day.sessions.length ? `  +${day.sessions.length} session` : "";
      return `${day.date}  ${vals}${memo}${ses}`.trimEnd();
    })
    .join("\n");
}

program.parseAsync(process.argv).catch(die);
