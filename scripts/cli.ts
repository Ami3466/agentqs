#!/usr/bin/env tsx
/**
 * agentqs — the CLI face of the same brain the web app runs on. Every verb maps to
 * a real library function the HTTP routes already call, so the terminal and the UI
 * drive one record:
 *
 *   agentqs chat "why have I felt off this week?"   → the grounded mentor agent (src/lib/agent.ts)
 *   agentqs journal [--table]                        → your life on one timeline (src/lib/journal.ts)
 *   agentqs sync --source github [--login u]         → the GitHub importer (src/lib/importers/github.ts)
 *   agentqs config get | set model <id>              → read/write config.json (src/lib/config.ts)
 *   agentqs serve --mcp                              → MCP stdio server (src/lib/mcp.ts)
 *
 * Heavy modules (the agent, embeddings, importers) are imported lazily per verb so
 * `config`/`journal` start instantly. Invoked through bin/agentqs.mjs.
 */

const BOOL = new Set(["table", "mcp", "json", "help", "h"]);

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      out.help = true;
    } else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (BOOL.has(k)) {
        out[k] = true;
      } else {
        const n = argv[i + 1];
        if (n === undefined || n.startsWith("--")) {
          out[k] = true;
        } else {
          out[k] = n;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const str = (v: string | boolean | string[] | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

const HELP = `agentqs — talk to your life record from the terminal

Usage:
  agentqs chat "<message>"           Ask the grounded mentor (streams the reply)
  agentqs journal [--table]          Your record: timeline, or a metrics table
  agentqs sync --source github       Pull commits into the record (--login/--token/--days)
  agentqs config get                 Show provider, model and data dir
  agentqs config set model <id>      Set the model to call
  agentqs serve --mcp                Run the MCP stdio server (for claude mcp add)

One brain, four faces — the same functions the web app and API routes call.`;

// ---- chat -----------------------------------------------------------------

async function cmdChat(args: Args): Promise<void> {
  const message = args._.join(" ").trim();
  if (!message) {
    console.error('agentqs chat: say something — agentqs chat "why am I tired lately?"');
    process.exit(2);
  }

  const { readConfig } = await import("../src/lib/config");
  const { effectiveMentors, mentorById } = await import("../src/lib/mentors");
  const { readSessionsFromRecord } = await import("../src/lib/record");
  const { recordDir, dbPath } = await import("../src/lib/paths");
  const { readGrounding, looksLikeDataQuestion, looksLikeRecallQuestion, groundedCrossSourceAnswer } =
    await import("../src/lib/grounding");
  const { continuityBlock, continuityFallbackReply } = await import("../src/lib/synthesis");

  const cfg = readConfig();
  const mentor = mentorById(str(args.mentor), effectiveMentors(cfg?.mentors));
  const prior = readSessionsFromRecord(recordDir());
  const grounding = readGrounding();

  // No key yet: mirror /api/chat's keyless path — semantic recall, else a real
  // cross-source answer computed from the numbers, else a mentor note. No network.
  if (!cfg?.llmProvider || !cfg?.llmKey) {
    if (looksLikeRecallQuestion(message)) {
      const { answerRecall } = await import("../src/lib/embeddings");
      const recall = await answerRecall(message, []);
      if (recall) return void process.stdout.write(recall.text + "\n");
    }
    if (grounding.sources.length >= 2 && looksLikeDataQuestion(message)) {
      const answer = groundedCrossSourceAnswer(grounding, message);
      if (answer) return void process.stdout.write(answer.text + "\n");
    }
    const opener = continuityFallbackReply(mentor.name, prior);
    process.stdout.write(
      (opener ??
        `I'm your ${mentor.name.toLowerCase()}. Add an AI key (Settings, or a provider key in config) ` +
          `and I'll answer this grounded in your real numbers. Until then, capture with >> and your record keeps building.`) +
        "\n",
    );
    return;
  }

  // Keyed: the same streaming tool-using agent the UI runs.
  const { dailyCatalog, resolveModel, streamMentor } = await import("../src/lib/agent");
  const dbFile = dbPath();
  const system = [mentor.system, dailyCatalog(dbFile).hint, continuityBlock(prior)]
    .filter(Boolean)
    .join("\n\n");

  let model;
  try {
    model = resolveModel(cfg.llmProvider, cfg.llmKey, cfg.model, cfg.llmModels);
  } catch (e) {
    console.error(`agentqs chat: ${(e as Error).message}`);
    process.exit(1);
  }

  const { textStream, used, err } = streamMentor({
    model,
    system,
    messages: [{ role: "user", content: message }],
    dbFile,
  });
  for await (const delta of textStream) if (delta) process.stdout.write(delta);
  process.stdout.write("\n");
  if (err.error) {
    console.error(`agentqs chat: model call failed — ${String((err.error as Error)?.message ?? err.error)}`);
    process.exit(1);
  }
  const sources = used.sources.size ? [...used.sources].sort() : used.hits > 0 ? grounding.sources : [];
  if (sources.length) console.error(`· grounded in ${sources.join(", ")}`);
}

// ---- journal --------------------------------------------------------------

async function cmdJournal(args: Args): Promise<void> {
  const { readJournal } = await import("../src/lib/journal");
  const data = readJournal();
  if (!data.days.length) {
    console.log("No record yet — connect a source (agentqs sync --source github) or drop a file in the app.");
    return;
  }

  if (args.table) {
    const cols = data.metrics.slice(0, 6);
    const days = data.days.slice(0, 14); // newest first
    const head = ["date", ...cols.map((c) => c.key)];
    const rows = days.map((d) => [d.date, ...cols.map((c) => d.values[c.key]?.text ?? "")]);
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log(fmt(head));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const r of rows) console.log(fmt(r));
    if (data.metrics.length > cols.length) {
      console.log(`\n… ${data.metrics.length - cols.length} more metric(s). See all in the Journal tab.`);
    }
    return;
  }

  console.log(`${data.totalDays} days · ${data.totalCells} data points · ${data.metrics.length} metrics\n`);
  for (const d of data.days.slice(0, 14)) {
    const filled = Object.keys(d.values).length;
    const bits = [`${filled} metric${filled === 1 ? "" : "s"}`];
    if (d.memos.length) bits.push(`${d.memos.length} memo${d.memos.length === 1 ? "" : "s"}`);
    if (d.sessions.length) bits.push(`${d.sessions.length} session${d.sessions.length === 1 ? "" : "s"}`);
    console.log(`${d.date}  ${bits.join(" · ")}`);
  }
}

// ---- sync -----------------------------------------------------------------

async function cmdSync(args: Args): Promise<void> {
  const source = str(args.source);
  if (source !== "github") {
    console.error(
      'agentqs sync: only --source github is a CLI verb today. Other sources: npm run import:source / import:file.',
    );
    process.exit(2);
  }

  const { importGithub, resolveGithubToken, windowDays } = await import("../src/lib/importers/github");
  const { rebuild } = await import("../src/lib/record");
  const { readConfig, writeConfig } = await import("../src/lib/config");
  const { recordDir } = await import("../src/lib/paths");

  const token = resolveGithubToken(str(args.token));
  const login = str(args.login);
  if (!token && !login) {
    console.error("agentqs sync: add --token <pat> (or set GITHUB_TOKEN), or --login <public-user>.");
    process.exit(2);
  }

  const { from, to } = windowDays(args.days ? Number(str(args.days)) : 90);
  let summary;
  try {
    summary = await importGithub({ token, login, from, to, recordDir: recordDir() });
  } catch (e) {
    console.error(`agentqs sync: ${(e as Error).message}`);
    process.exit(1);
  }

  const cfg = readConfig();
  if (cfg) {
    const t = str(args.token);
    if (t) cfg.githubToken = t;
    cfg.githubSyncedAt = new Date().toISOString();
    try {
      writeConfig(cfg);
    } catch {
      /* non-fatal: the record already has the data */
    }
  }

  const r = rebuild({ recordDir: recordDir() });
  console.log(
    `GitHub: ${summary.total} commit(s) over ${summary.daysWithCommits} active day(s), ${summary.from} … ${summary.to}.`,
  );
  console.log(`Cache rebuilt: ${r.daily} daily rows.`);
}

// ---- config ---------------------------------------------------------------

async function cmdConfig(args: Args): Promise<void> {
  const { readConfig, writeConfig } = await import("../src/lib/config");
  const { dataDir } = await import("../src/lib/paths");
  const sub = args._[0] ?? "get";

  const cfg = readConfig();
  if (sub === "get") {
    if (!cfg) return void console.log("Not set up yet — start the app and finish setup.");
    console.log(`username  ${cfg.username}`);
    console.log(`provider  ${cfg.llmProvider || "(none)"}`);
    console.log(`model     ${cfg.model || "(none)"}`);
    console.log(`key       ${cfg.llmKey ? "••••" + cfg.llmKey.slice(-4) : "(none)"}`);
    console.log(`data dir  ${dataDir()}`);
    return;
  }

  if (sub === "set") {
    if (!cfg) {
      console.error("agentqs config set: not set up yet — start the app and finish setup.");
      process.exit(1);
    }
    const key = args._[1];
    const value = args._[2] ?? "";
    if (key === "model") {
      cfg.model = value;
    } else if (key === "provider") {
      const { isProvider } = await import("../src/lib/models");
      if (value && !isProvider(value)) {
        console.error(`agentqs config set: unknown provider "${value}" (anthropic|openai|google).`);
        process.exit(2);
      }
      cfg.llmProvider = value;
    } else {
      console.error('agentqs config set: unknown key — use "model" or "provider".');
      process.exit(2);
    }
    writeConfig(cfg);
    console.log(`Set ${key} = ${value || "(empty)"}`);
    return;
  }

  console.error("agentqs config: use `get` or `set model <id>`.");
  process.exit(2);
}

// ---- serve --mcp ----------------------------------------------------------

async function cmdServe(args: Args): Promise<void> {
  if (!args.mcp) {
    console.error("agentqs serve: pass --mcp to start the MCP stdio server.");
    process.exit(2);
  }
  const { serveMcp } = await import("../src/lib/mcp");
  const { dbPath } = await import("../src/lib/paths");
  await serveMcp(dbPath());
}

// ---- router ---------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = parse(argv.slice(1));
  if (rest.help && cmd !== "serve") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "chat":
      return cmdChat(rest);
    case "journal":
      return cmdJournal(rest);
    case "sync":
      return cmdSync(rest);
    case "config":
      return cmdConfig(rest);
    case "serve":
      return cmdServe(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`agentqs: unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exit(2);
  }
}

void main();
