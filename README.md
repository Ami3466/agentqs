
<img src="public/logo.svg" alt="agentqs" width="160" />

# agentqs

**Use your data to unlock insights on your productivity, mental health and more.**

---

There are thousands of products helping companies use their knowledge bases and analytics. Our most important data stays neglected - every person has millions of data points recorded, tracking on purpose or not.

agentqs is the pipeline for it: connect 20+ apps, scrape the ones that lock your data in. It structures, indexes and embeds everything - then you learn from it with graphs, AI with skills, or voice sessions. Works out of the box in the web app, CLI, Slack or Telegram.

---

## Quick start

![Deploy on FlowEngine](https://flowengine.cloud/button.svg)```bash
git clone https://github.com/Ami3466/agentqs.git && cd agentqs
npm install
npm run dev               # → http://localhost:3000
```

It's recommended to work directly on the repo or with skill with Claude Code / Codex. Ask it to start onboarding your accounts and manually import and structure the data it found locally, then set up API keys and automated data imports, structure the data and index it, then add the skills you want and start unlocking personal insights.

## Features

### Journal - your whole life in one table

Every source lands in one daily record: sleep, steps, mood, focus, screen time, heart rate, workouts, commits. Table or timeline, built from plain CSVs you own. **Scan data** checks every column's quality: the same metric imported twice (manually and by a sync) gets merged - the auto-synced column wins, and a saved rule keeps future imports in one column - dead all-zero columns get dropped, and messy values (units, junk placeholders) get cleaned. Every fix is one click and undoable.

![Journal](docs/images/journal.png)### Chat - AI grounded in your record, with skills

Ask anything - the agent answers from your actual data: SQL over metrics, text search over memos and sessions, semantic search over everything. `//` logs a memo, `/` runs commands.

![Chat](docs/images/chat.png)### Data - ingest anything

Drop a file or folder, hit **Structure**, it lands in your record. CSVs with a date column map directly - no LLM. Every capture shows in the log: structured, pending or rejected.

![Data workspace](docs/images/data.png)### Graphs

Correlate anything - sleep vs focus, screen time vs mood - and save the views.

![Graphs](docs/images/graphs.png)### CLI, API and MCP - every action, no API key

Everything works from the terminal or any CLI agent:

```bash
agentqs chat "what changed this week?"
agentqs import ./export.csv --name mood
agentqs query "select date, value_num from daily where metric='mood'"
```

**No AI key? Use a CLI agent as the AI.** Everything the app does is reachable key-free: capture, import, sync, query, semantic recall (local embeddings), rebuild - and for the two flows that normally need a model, the agent does the reasoning itself:

```bash
agentqs inbox --json                      # pending captures, full text
agentqs structure --id <id> --csv "date,mood,steps
2026-01-05,8,14200"                       # the agent supplies the extracted CSV
agentqs recall "days that felt burned out" # meaning-search, fully on-device
```

Expose it to Claude Code or Codex over MCP - the agent reads, writes and queries through local tools without spending your in-app API key (the repo's `CLAUDE.md` teaches these workflows automatically):

```bash
claude mcp add-json agentqs '{"command":"agentqs","args":["serve","--mcp"]}'
```

### Slack and Telegram

Connect a channel in Settings - log memos and ask your record questions from where you already are.

## Integrations

**Connect by API or OAuth:** GitHub · WHOOP · Oura · Fitbit · Withings · Strava · RescueTime · Toggl Track · Todoist · Google Calendar · Spotify · Last.fm · Deezer · Trakt · Notion · Swarm · Mastodon · Granola

**Scrape or import from locked-in apps:** Google MyActivity (browser extension) · Google Takeout archives · Google Timeline · Chrome browser history · iPhone backups · Notion exports · Spotify data export · any CSV, TSV, Markdown or text file

Semantic search runs on local embeddings - no API key needed. Chat and structuring use whatever provider you add: Anthropic, OpenAI, Gemini or any compatible endpoint.

## Deploy locally

Keep your record outside the repo:

```bash
export AGENTQS_DATA_DIR="$HOME/agentqs-data"
npm run build
npm run dev
```

Or with Docker:

```bash
docker run -d \
  -v ~/agentqs-data:/data \
  -p 3000:3000 \
  -e AGENTQS_DATA_DIR=/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  agentqs
```

Your record is plain text (`record/daily/*.csv`, `inbox.jsonl`, `sessions.jsonl`) and can live in a private git repo. Databases and embeddings are derived - `agentqs rebuild` recreates them.

## Deploy on cloud

Scheduled syncs need a machine that's always on. On your own machine one crontab line does it - `0 * * * * agentqs sync --due` runs every source whose interval says it's due, browser scrapes included (copy it from Settings → API → Connect). [**Deploy on FlowEngine**](https://flowengine.cloud/deploy/agentqs) - up 24/7, persistent storage at `/data`.

![Deploy on FlowEngine](https://flowengine.cloud/button.svg)Any other host: mount storage at `/data`, set `AGENTQS_DATA_DIR=/data`, keep a stable `SESSION_SECRET`. Cloud can't read your laptop - for browser history, iPhone backups or photos, run the CLI on the machine that has the files.

## Good to know

- **Private by default.** Data stays in your data directory. Model calls only get what you ask to send.
- **Token use is explicit.** Capture and search are local. AI runs only when you chat, structure prose, or run a channel - CLI-agent workflows skip it entirely.

## License

**Free to use. Not for sale.**

agentqs is [MIT with the Commons Clause](LICENSE): use it, self-host it, change it, share it. You may **not** sell it or offer it as a paid product or service, including paid hosting or support built on it.