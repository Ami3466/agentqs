<h1 align="center">agentqs</h1>
<p align="center"><b>A journal that builds itself — and the best mentor and therapist you've ever had.</b></p>
<p align="center">It knows everything about you. It finds your patterns, helps you replicate what works, keeps you on your good habits, and gives you real clarity and awareness over your own life.</p>

<p align="center">
  <a href="https://flowengine.cloud/deploy/agentqs">
    <img src="https://flowengine.cloud/button.svg" alt="Deploy on FlowEngine" height="40">
  </a>
  &nbsp;·&nbsp;
  <a href="#"><b>Read the story →</b></a>
</p>

---

You don't fill it in. You live your life, connect your sources, and talk to it like a friend — and the record **builds itself.** Then ask it anything and get an answer grounded in **your** numbers, not generic advice.

- ✅ **Talk to your life** — "why have I felt off this week?" → an answer from your actual sleep, heart rate, calendar and messages
- ✅ **Every source, one record** — WHOOP, Apple Health, calendar, Spotify, GitHub, browsing, WhatsApp, location — merged into one daily table
- ✅ **Capture anything** — type it, drop a file, or hit record for a voice memo; turn it into structured data with one click
- ✅ **It remembers** — dated mentor sessions and the patterns that emerge across them build over time
- ✅ **Any AI provider** — Claude, OpenAI, Gemini. Paste your key; models load in.
- ✅ **Built for Claude Code** — every screen shows its CLI command, API call, and MCP config

Runs on **your own server** and **your own AI key**. Your data lives in your own private git repo — nothing leaves except the questions you send your model.

---

## What you'd use it for

- **"Why am I tired / off / anxious lately?"** — grounded in the week's real signals, not a horoscope
- **Weekly review** — what changed, what correlated, what to try next week
- **Decisions with your own history** — "should I take this on? what happened last time I did?"
- **Spot your patterns** — "fire days cost me +10 bpm and 47 minutes of sleep"
- **A journal that talks back** — capture a memo, get reflection, never a blank page

## Set up in 4 steps

Connect a source or two, ask your first question, and you're in. No terminal required — though it's right there if you want it.

| 1. Connect data | 2. Ask anything | 3. Capture | 4. Bring your AI |
|---|---|---|---|
| ![Connect](docs/images/onboarding-connect.png) | ![Ask](docs/images/onboarding-chat.png) | ![Capture](docs/images/onboarding-capture.png) | ![AI](docs/images/onboarding-ai.png) |
| Link APIs or drop a file | Get a grounded answer | Type, voice-memo, or drag-drop | Paste any key — models load in |

## Chat — your mentor

One conversation, Claude-Code style. Plain text talks to the mentor. `>>` logs a memo. `/` runs a command.

Or **start a live voice session** — talk it out with a therapist grounded in the methodology *you* choose (CBT, ACT, schema, IFS…), or any persona you build. It listens, reflects, and quietly **writes the key points back into your daily record.** No forms, no data entry — **the database builds itself from your conversations.**

Replies always quote your real numbers. Switch persona any time.

![Chat](docs/images/chat.png)

## Journal — your life on one timeline

Every day in one place: metrics, memos, and the mentor session you had that day, side by side. Flip to a Notion-style table to show/hide/reorder columns and save your own views.

![Journal](docs/images/journal.png)

## Data — one pipe, all your sources

Connect apps, set a sync interval per source, and drop files into the inbox. Hit **Structure** to turn raw notes and exports into clean daily data — you only pay the AI when you press the button.

![Data](docs/images/data.png)

## Built for Claude Code

A Supabase-style bar on top surfaces the **CLI command** and **API call** for whatever you're viewing, plus one-click **Connect to Claude Code** (MCP). Drive your whole life record from the terminal.

![API bar](docs/images/api-bar.png)

## Integrations

One daily record, fed from wherever your life happens.

**Body & health**
- **WHOOP — per-minute.** Not just a daily score: **minute-by-minute heart rate**, HRV, recovery, sleep stages and strain. This is what makes correlations *real* — "that meeting spiked me to 110," "this person costs me +10 bpm," "I never recover on days I skip lunch." Most tools only ever see your daily average. **agentqs sees every minute.**
- **Apple Health** — steps, heart rate, sleep, workouts, energy.

**Focus & work**
- **RescueTime** — where your hours actually go
- **GitHub** — commits per day
- **Browsing** — what you read (Chrome/Firefox/Safari history)
- **Screen Time** — per-app usage from your iPhone

**Life**
- **Google Calendar** — meetings, and how they land on your body
- **Spotify** — what you listened to
- **Notion** — your journals and notes
- **WhatsApp / iMessage** — conversation history
- **Location** — where you were (OwnTracks live, or Google Timeline)

**Anything else** — drag-drop any CSV, text export, or screenshot. The agent works out what it is and structures it. No importer required.

## Run locally

```bash
cp .env.example .env       # AI key optional — add providers in the UI
npm install
npm run dev                # → http://localhost:3000
```

Embeddings run on a local model out of the box — no key, no cost, nothing to set up. Semantic search ("find days that felt like this") works on first run.

## Self-host with Docker

The container runs the full app — UI, mentor, API syncs, bots, scheduler. Two things to know about **file-based** sources (Chrome history, iPhone backup), because those live on *your* machine, not in the container:

```bash
docker run -d \
  -v ~/agentqs-data:/data \                                  # your record + SQLite (persist this)
  -v "$HOME/Library/Application Support/Google/Chrome:/host/chrome:ro" \  # optional: local file sources
  -e ANTHROPIC_API_KEY=sk-... \
  -p 3000:3000 agentqs
```

- **Docker on the machine that has your data** (your Mac, a NAS): mount those paths read-only and agentqs reads them directly.
- **Docker on a remote server** (VPS, Coolify): the container can't reach your laptop's files. Run the small local importer on your machine — it commits file-sourced data into your record repo, and the server pulls it. **Git is the sync layer**, so the remote instance still sees everything.
- API sources (WHOOP, Calendar, GitHub…) work anywhere — no local machine needed.

## The record (source of truth)

Your life lives as **plain text in a git repo** — human-readable, diffable, and importable by a script in any language. The SQLite database is just a **rebuildable cache** (never committed); the record is the truth.

```
record/
  daily/<source>.csv   one wide CSV per source, first column `date`
  inbox.jsonl          one raw capture per line (the pending bucket)
  sessions.jsonl       one mentor/therapy session per line
```

Each `daily/*.csv` is melted into long form — `(date, source, metric, value)` — so any new source, or any CSV you drop in, adds its columns with **zero schema migration**.

Rebuild the cache from the record any time — it's pure, so the same record always yields the same database:

```bash
npm run rebuild            # rebuild ./data/agentqs.db from ./data/record
npm run rebuild:verify     # build the sample record twice, prove the bytes are identical
```

## Good to know

- **Private by design.** Your data lives in your own git repo and your own server. Nothing is sent anywhere except the slices you ask your model about. BYO key.
- **WHOOP per-minute** rides your WHOOP app connection, not the limited public API — use your own account.
- **Local-first.** Everything works offline except API syncs and the messaging bots.
- **Cheap by design.** Raw capture is free; you only spend tokens when you press *Structure* or ask a question. Embeddings run locally.

MIT licensed. Full build plan in [agentqs-plan.md](agentqs-plan.md).
