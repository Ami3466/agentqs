# agentqs — fix prompt

Repo: ~/Desktop/agentqs (Next.js/TS). Reference wpbot at ~/Desktop/wpbot.
Global rules: STRICTLY MONOCHROME · minimal copy (no marketing, no possessives like "your"/"your life", no redundant hints) · real brand logos only (simple-icons inline SVG, no sparkles/placeholders) · everything FUNCTIONAL (no dummy stubs, no fake rows) · zero personal/dummy data · CLI-first (CLI + API + MCP reach every capability) · build must pass before commit.

## 1. Providers backbone (model-agnostic)
- Settings: an AI-providers LIST you add to — Anthropic, OpenAI, Google, OpenRouter, Groq, custom endpoint. Each = label + API key + base URL. Models FETCHED LIVE per provider (wpbot fetchModels, GET /models). Never hardcoded. Persist in config.
- Chat: a MODEL switcher chip — pick any model from any added provider, switch mid-conversation. Separate from the skill chip.
- Settings pickers: Embedding model (local default all-MiniLM, no key; optional API model + key) · Voice model (ElevenLabs OR Google Live + key) · Channels (link Telegram bot token + Slack). Show the data path.

## 2. Data page
- Lead with "Drop data here": drag-drop ANY file incl. photos → inbox → Structure. Photos are NOT a separate panel.
- Two tabs: Connections | Automated imports.
- Connections = automated API/OAuth ONLY. Each row = real brand logo + name + Connect + sync-interval. NO description subtext, NO api/manual tag/badge, NO breadcrumbs.
- No-API sources: file exports → the drop-zone; auto-import-without-API → "Set up automation" (record a login via Playwright + schedule cron) under Automated imports.
- Remove fake "connected · updated 6h ago" rows and fake "Set up" rows.
- Full roster: Oura, Health Connect, Fitbit, Garmin, Withings, Strava, RescueTime, Todoist, Toggl, GitHub, Instapaper, Mastodon, Google Calendar, Swarm, Last.fm, Trakt, Apple Weather, Spotify, Deezer, Notion, WHOOP. API-first (Notion = API). WHOOP = UNOFFICIAL password per-minute pull.
- Per-connection sync intervals. "Automate imports" button in the inbox.

## 3. Log (was "Daily table")
- Rename → Log. Minimal, NO description.
- Render CLEANLY per-day (readable rows, not raw date/source/metric/value label-soup).
- Hide FUTURE-dated events (only up to today).
- Add AND delete columns (define your own metric; remove ones you don't want).

## 4. Chat
- `//` = memo (not `>>`) — fix smart-input modeOf + memoText + all hints; check `//` before `/`. Commands must work.
- Model switcher chip + skill chip.
- Input PINNED to the bottom; messages scroll (up/down) in their own area.
- Delete sessions from the session list.
- Sessions in the Journal: compact, not big blocks, don't dump every chat.
- Agent WRITE tools: log_memo, save_insight / save_commitment (+ structure) so conversation feeds the record — "the database builds itself." (Today the agent is read-only.)
- Less compacted, cleaner.

## 5. Skills (was "Mentors")
- Rename Mentors → Skills everywhere. Remove the "voices your chat can take" description.
- Real ADD and DELETE that works. 3 built-in, DEFAULT none, "+" to add.

## 6. Onboarding
- Signup: email + password + confirm ONLY. No fluff lines.
- Welcome popup (before the tour): copy-CLI start OR "Start with demo data". Demo = GENERIC, isolated, never the user's real data.
- Tour: DONE (driver.js spotlight).
- Logo: simple minimal monochrome wordmark "agent" + "qs".

## 7. Connect popup (exactly 3 lines)
- API key (generate) · `agentqs sync --source github` (copy) · copy skill | copy mcp. Nothing else.

## 8. Global copy sweep
- Delete ALL redundant text/tags/descriptions/hints. Kill examples: "Add your AI key later in Settings", "Your data lives in your own git repo, on your own server", "Or set GITHUB_TOKEN in the environment".
- No "your" / "your life" / "your record" — plain labels.
