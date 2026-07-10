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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { loadEnvConfig } from "@next/env";
// The Next server loads .env/.env.local (AGENTQS_DATA_DIR lives there); the CLI
// and MCP must resolve the SAME store or the app splits across two data dirs.
loadEnvConfig(process.cwd(), undefined, { info: () => undefined, error: () => undefined });
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

program
  .command("journal-edit <edits>")
  .description("apply daily table edits from a JSON array")
  .action((edits: string) => {
    try {
      const parsed = JSON.parse(edits);
      if (!Array.isArray(parsed)) throw new Error("edits must be a JSON array.");
      out(core.journalEdit(parsed), (d) => `Applied edits: ${d.sets} set, ${d.clears} cleared, ${d.deletedColumns} columns, ${d.deletedRows} rows.`);
    } catch (e) {
      die(e);
    }
  });

// ---- data-quality scanner -----------------------------------------------------
program
  .command("scan")
  .description("scan data quality: duplicate daily columns, dead all-zero columns, messy values — findings queue as fix notifications")
  .option("--fix", "apply every open fix now (merges also save their rule)")
  .action((opts: { fix?: boolean }) => {
    try {
      out(core.scan({ fix: opts.fix }), (d) => {
        const lines: string[] = [];
        let open = 0;
        for (const m of d.autoMerged) lines.push(`auto-merged ${m.from} → ${m.into} (${m.moved} moved, ${m.kept} conflicts kept)`);
        for (const f of d.findings) {
          if (f.notificationStatus === "pending") open++;
          const state = f.notificationStatus === "pending" ? "" : ` [${f.notificationStatus}]`;
          const target = f.kind === "merge" ? `${f.key} → ${f.into}${f.intoAuto ? " (auto wins)" : ""}` : f.key;
          lines.push(`${f.kind}  ${target}  ${f.reason}${state}`);
        }
        for (const m of d.fixed) lines.push(m.summary);
        if (!lines.length) return "No data-quality issues found.";
        if (open && !d.fixed.length) {
          lines.push(`\n${open} finding${open === 1 ? "" : "s"} queued as inbox notifications — structure one to apply its fix, or rerun with --fix.`);
        }
        return lines.join("\n");
      });
    } catch (e) {
      die(e);
    }
  });

const log = program.command("log").description("inspect and reject captured log items");
log
  .command("list", { isDefault: true })
  .description("show recent inbox/log items")
  .option("-l, --limit <n>", "items to show", (v) => parseInt(v, 10), 50)
  .action((opts: { limit: number }) => {
    try {
      out(core.logItems(opts.limit), (rows: any[]) =>
        rows.length
          ? rows.map((i) => `${i.ts}  ${i.status.padEnd(10)}  ${i.id}  ${i.text.slice(0, 80).replace(/\s+/g, " ")}`).join("\n")
          : "(no log items)",
      );
    } catch (e) {
      die(e);
    }
  });
log
  .command("reject <id>")
  .description("mark a log item rejected")
  .action((id: string) => {
    try {
      out(core.logReject(id), (d) => `Rejected ${d.id}.`);
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
  .command("pipeline")
  .description("the data-pipeline truth table: origin, credential provenance, schedule, last run, landed data")
  .action(() => {
    try {
      out(core.pipeline(), (r: any) => {
        const rows = r.sources
          .filter((s: any) => s.connected || s.scheduled || s.lastRun)
          .map((s: any) => {
            const cred = s.connected
              ? s.credentialOrigin
                ? `cred: ${s.credentialOrigin}`
                : "data present (no credential)"
              : s.detectedApp
                ? "NOT connected — app login detected (Connect in Data imports it as a credential)"
                : s.hasData
                  ? "NOT connected — imported data only"
                  : "not connected";
            const sched = s.scheduled ? `every ${s.interval}` : "manual";
            const run = s.lastRun
              ? `last run ${s.lastRun.at.slice(0, 16)} ${s.lastRun.ok ? "ok" : `FAILED: ${s.lastRun.error ?? ""}`}`
              : "no ledgered run";
            const data = s.data.events || s.data.days
              ? `${s.data.events ? `${s.data.events.toLocaleString()} events` : `${s.data.days.toLocaleString()} days`}${s.data.from ? ` · ${s.data.from} → ${s.data.to}` : ""}`
              : "no data";
            return `${s.connected ? "●" : "○"} ${s.id.padEnd(24)} ${s.origin.padEnd(10)} ${sched.padEnd(12)} ${cred.padEnd(32)} ${run}\n${" ".repeat(26)}${data}`;
          });
        const sch = r.scheduler;
        return [
          ...rows,
          "",
          `scheduler: launchd ${sch.launchd ? "installed" : "—"} · crontab ${sch.crontab ? "installed" : "—"} · last sync --due sweep: ${sch.lastDueRunAt ?? "never recorded (ledger is new; check scheduler logs)"}`,
        ].join("\n");
      });
    } catch (e) {
      die(e);
    }
  });

program
  .command("doctor")
  .description("store health: sync-engine exposure, evicted files, conflict twins, split stores")
  .action(() => {
    try {
      const r = core.doctor();
      out(r, (rep: any) => {
        const icon = (s: string) => (s === "ok" ? "●" : s === "warn" ? "▲" : "✗");
        const lines = rep.checks.map((c: any) => `${icon(c.severity)} ${c.title.padEnd(16)} ${c.detail}`);
        lines.push(
          "",
          rep.safe
            ? `store: ${rep.dataDir}${rep.atDefault ? " (default safe location)" : ""}`
            : `store: ${rep.dataDir} — UNSAFE, run: agentqs migrate-store`,
        );
        return lines.join("\n");
      });
      if (!r.safe) process.exitCode = 1;
    } catch (e) {
      die(e);
    }
  });

program
  .command("migrate-store")
  .description("move the store to a sync-safe location (default: the platform app-data dir); stop the app first")
  .option("--to <dir>", "explicit target directory")
  .option("--dry-run", "show what would move without touching anything")
  .action((opts: { to?: string; dryRun?: boolean }) => {
    try {
      out(core.storeMigrate({ to: opts.to, dryRun: opts.dryRun }), (r: any) =>
        [
          r.dryRun
            ? `DRY RUN — would move ${r.files} files (${Math.round(r.bytes / 1e6)} MB): ${r.from} → ${r.to}`
            : `Moved ${r.files} files (${Math.round(r.bytes / 1e6)} MB): ${r.from} → ${r.to} (hash-verified)`,
          ...(r.retiredTo ? [`old store retired at ${r.retiredTo}`] : []),
          ...r.schedulers,
          ...r.next,
        ].join("\n"),
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
  .option("--due", "only sources whose schedule says so — the crontab mode (API sources + browser automations)")
  .action(async (positional: string | undefined, opts: { source?: string; credential?: string; days?: number; fixture?: string; due?: boolean }) => {
    const source = positional ?? opts.source;
    try {
      if (opts.due) {
        const { syncDue } = await import("../src/lib/sync-due");
        const r = await syncDue();
        out(r, () =>
          [
            `Due ${r.due} — synced ${r.synced.length}, failed ${r.failed.length}, skipped ${r.skipped.length}.`,
            ...r.synced.map((s) => `  ✓ ${s.id} (${s.kind})`),
            ...r.failed.map((s) => `  ✗ ${s.id} (${s.kind}): ${s.error}`),
          ].join("\n"),
        );
        if (r.failed.length) process.exitCode = 1;
        return;
      }
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

// ---- whoop: the unofficial app login (email + password → token) -----------
const whoop = program.command("whoop").description("WHOOP via the unofficial app login (per-minute HR)");

whoop
  .command("connect <email> <password>")
  .description("prove the WHOOP login, then store it (then: agentqs sync whoop)")
  .action(async (email: string, password: string) => {
    try {
      out(await core.whoopConnect(email, password), (d) => `Connected WHOOP as ${d.email}. Run: agentqs sync whoop`);
    } catch (e) {
      die(e);
    }
  });

const whisper = program.command("whisper").description("manage built-in local Whisper for voice memos");
whisper
  .command("status", { isDefault: true })
  .description("show installed local Whisper models")
  .action(() => {
    try {
      out(core.whisperStatus(), (d) =>
        `active=${d.active || "(none)"} lang=${d.lang}\n` +
        d.models.map((m: any) => `${m.installed ? "●" : "○"} ${m.id.padEnd(6)} ${m.size} ${m.hint}`).join("\n"),
      );
    } catch (e) {
      die(e);
    }
  });
whisper
  .command("install <model>")
  .description("download and activate: tiny | base | small")
  .action(async (model: string) => {
    try {
      out(await core.whisperInstall(model), (d) => `Whisper active: ${d.active || "(none)"}.`);
    } catch (e) {
      die(e);
    }
  });
whisper
  .command("remove [model]")
  .description("remove a local Whisper model")
  .action((model?: string) => {
    try {
      out(core.whisperRemove(model), (d) => `Whisper active: ${d.active || "(none)"}.`);
    } catch (e) {
      die(e);
    }
  });

// ---- source subcommands: connect / interval / file ------------------------
const source = program.command("source").description("manage sources (connect, schedule, file import)");

source
  .command("connect <id> <credential>")
  .description("test + save an API source's credential (connected always means a stored, WORKING key)")
  .action(async (id: string, credential: string) => {
    try {
      // Prove the key against the real API first — a typo'd credential fails
      // here, loudly, instead of on next week's scheduled sync.
      const probe = await core.testSourceCredential(id, credential);
      out({ ...core.connectSource(id, credential), tested: probe.detail }, (d) => `Connected ${d.id} — ${probe.detail}.`);
    } catch (e) {
      die(e);
    }
  });

source
  .command("guide <id>")
  .description("how to connect a source: where its credential comes from, step by step")
  .action((id: string) => {
    try {
      out(core.sourceGuide(id), (g) => {
        const lines = [
          `${g.name} — ${g.credentialLabel}`,
          ...g.steps.map((s: string, i: number) => `  ${i + 1}. ${s}`),
        ];
        if (g.url) lines.push(`  Start here: ${g.url}`);
        if (g.oauth) {
          lines.push(
            "  Expiring tokens — connect via the OAuth authorize flow in the web app (Pipeline → Connect).",
            `  Register this redirect URI on the provider app: ${g.redirectUriHint}`,
          );
        }
        return lines.join("\n");
      });
    } catch (e) {
      die(e);
    }
  });

source
  .command("test <id> [credential]")
  .description("prove a source's credential works against the real API — nothing saved")
  .action(async (id: string, credential?: string) => {
    try {
      out(await core.testSourceCredential(id, credential), (d) => `${d.name}: ${d.detail}.`);
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
  .option("-d, --days <n>", "trailing window; Chrome Takeout JSON defaults to all", (v) => parseInt(v, 10))
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
  .action(async (file: string, opts: { name?: string }) => {
    try {
      out(await core.importRaw({ file, name: opts.name }), (d) => d.note);
    } catch (e) {
      die(e);
    }
  });

program
  .command("structure")
  .description("turn pending inbox captures into daily rows (CSV free; prose via AI key OR --csv from a CLI agent)")
  .option("--id <id>", "structure one item")
  .option("--csv <csv>", "key-free agent route: supply the extracted daily CSV yourself (requires --id)")
  .option("--csv-file <path>", "like --csv but read the CSV from a file")
  .action(async (opts: { id?: string; csv?: string; csvFile?: string }) => {
    try {
      const csv = opts.csv ?? (opts.csvFile ? fs.readFileSync(opts.csvFile, "utf8") : undefined);
      const r = await core.structure({ id: opts.id, csv });
      out(r, (d) => (d.ok ? `Structured ${d.structured}; ${d.pending} still pending.` : d.error));
    } catch (e) {
      die(e);
    }
  });

program
  .command("inbox")
  .description("pending captures with full text (the input for `structure --id --csv`)")
  .action(() => {
    try {
      out(core.inboxPending(), (d) =>
        d.items.map((i: { id: string; ts: string; source: string; kind: string; text: string }) => `${i.id}  ${i.ts.slice(0, 10)}  ${i.source}/${i.kind}  ${i.text.slice(0, 80).replace(/\n/g, " ")}`).join("\n") ||
        "Inbox empty.",
      );
    } catch (e) {
      die(e);
    }
  });

program
  .command("recall <query...>")
  .description("semantic recall over memos/sessions/journal text — local embeddings, no AI key")
  .option("-n, --limit <n>", "max hits", (v) => parseInt(v, 10))
  .action(async (words: string[], opts: { limit?: number }) => {
    try {
      const r = await core.recall(words.join(" "), opts.limit);
      out(r, (d) =>
        d.hits.map((h: { date: string; kind: string; snippet: string }) => `${h.date}  [${h.kind}]  ${h.snippet}`).join("\n") || "No semantic matches.",
      );
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

// ---- photos ---------------------------------------------------------------
const photos = program.command("photos").description("bring photos into the record (local: EXIF, thumbnails, CLIP recall)");

photos
  .command("import [folder]", { isDefault: true })
  .description("import a folder (or --library) of photos; originals never leave your machine")
  .option("--library", "scan the macOS Photos library originals")
  .option("--since <date>", "only photos modified on/after this ISO date")
  .option("--caption", "run the local caption model → scene tags (slower)")
  .option("--push", "git commit + push the record after import")
  .action(async (folder: string | undefined, opts: { library?: boolean; since?: string; caption?: boolean; push?: boolean }) => {
    try {
      const r = await core.photosImport({ folder, library: opts.library, since: opts.since, caption: opts.caption, push: opts.push });
      out(r, (d) =>
        `Imported ${d.imported} photo(s) (${d.skipped} already known): ${d.thumbnails} thumbnails, ${d.embedded} embedded${
          d.captioned ? `, ${d.captioned} captioned` : ""
        }, ${d.withGps} geotagged. Record now holds ${d.total}.${d.pushed ? " Pushed." : ""}`,
      );
    } catch (e) {
      die(e);
    }
  });

photos
  .command("status")
  .description("how many photos are in the record, indexed, geotagged")
  .action(() => {
    try {
      out(core.photosStatus(), (d) =>
        d.count === 0
          ? "No photos yet. Import some: agentqs photos <folder>"
          : `${d.count} photos (${d.firstDate}…${d.lastDate}) · ${d.indexed} indexed for recall · ${d.withGps} geotagged · ${d.captioned} captioned${
              d.cameras.length ? ` · cameras: ${d.cameras.join(", ")}` : ""
            }`,
      );
    } catch (e) {
      die(e);
    }
  });

photos
  .command("search <query...>")
  .description("text → image recall: find photos matching a description (local CLIP)")
  .option("-l, --limit <n>", "results", (v) => parseInt(v, 10), 8)
  .action(async (words: string[], opts: { limit: number }) => {
    try {
      const hits = await core.photosSearch(words.join(" "), opts.limit);
      out(hits, (rows: any[]) =>
        rows.length
          ? rows.map((h) => `${h.date}  ${String(h.score).padEnd(5)}  ${h.caption ?? h.thumb ?? h.id}`).join("\n")
          : "(no matches — import photos first, or the CLIP index is empty)",
      );
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
    const root = path.join(here, "..");
    const child = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", "-p", opts.port], {
      stdio: "inherit",
      cwd: root,
      env: { ...process.env, HOSTNAME: process.env.HOSTNAME || "0.0.0.0" },
    });
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
