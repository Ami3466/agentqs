# agentqs — plan

**agentqs** = a personal AI mentor. Ingest your whole life data into one private daily record, then talk to an agent that reasons over it like a friend who read your whole file.

**Wedge:** data + a reasoning mentor, *fused*. Journaling apps have the chat but no data; life-capture apps have the data but no brain. Nobody ships both.

## Locked decisions
- **Stack:** TypeScript product (UI, chat, agent, channels, daemon). Data importers can be standalone scripts (any language) behind the record contract. **Framework: Vercel AI SDK** — provider-agnostic; default Claude, BYO key can use GPT/Gemini. Not the Claude Agent SDK (Claude-locked).
- **Architecture:** plain text files in a private git repo per user = source of truth. One SQLite file = rebuildable derived cache (never committed). FTS5 keyword search is free; sqlite-vec embeddings live inside the same file.
- **Daemon:** one binary — `ingest | sync | query | chat | serve`. `serve` exposes the local web app + JSON API. The same daemon deploys as an always-on cloud replica for bots + remote access. **Git is the sync layer** between local and cloud.
- **Embeddings:** default-on, zero user setup. sqlite-vec bundled + a local embedding model (no key, no cost, private). Background-indexes meaningful text (daily summaries / journal / memos) on first run. Optional higher-quality API-embeddings toggle later. SQL+FTS5 covers structured data.
- **Channels:** Slack + Telegram (official APIs). WhatsApp later, official Cloud API only (never Baileys — data/ban risk). Channel = transport; sensitive data stays in the user's store.
- **Voice:** memo = local Whisper STT → inbox. Live session = ElevenLabs Conversational AI (keeps Claude as the brain + premium voice + turn-taking). Gemini Live = cheap fallback.
- **WHOOP:** per-minute (heart rate, HRV, recovery, sleep, strain) via the WHOOP app connection — the differentiator. Official public API (daily summary only) is the fallback.
- **Money:** consumer subscription thesis; no billing until people ask.
- **Name:** agentqs (placeholder; revisit at launch).

## Tabs (4) + a Supabase-style API/CLI bar
Top bar carries a persistent, context-aware **Connect / API** affordance: on each tab it shows the equivalent CLI command + API call, plus one-click **Connect to Claude Code** (MCP config). One brain, three faces — the UI surfaces the CLI/API face of whatever you're viewing.

- **Chat** — mentor; text + `>>` memo + `/` command; skill chip; live voice-session toggle; sessions sidebar. Global mic = voice memo (separate from the in-chat voice session). The conversation writes key points back into the record — the database builds itself.
- **Journal** — your life on one timeline: metrics + memos + mentor sessions as dated entries, side by side. Timeline view + Table view (TanStack, Notion-style show/hide/reorder/resize + saved views). *Sessions live here in the UI but are stored separately (typed store + synthesis layer) so the agent reads synthesis, not raw transcripts — UI-merged, storage-separate.*
- **Data** — sources (manual/api) + last-sync + per-source interval + lazy-sync-on-open + Pending inbox (Structure button).
- **Settings** — BYO LLM key + model pick, skills management, data path.

## Chat UI
Three zones: sessions sidebar (left) · conversation (center, streaming, grounded replies with numbers + sparkline) · smart input (bottom).
- plain text → talk to the mentor
- `>>` → memo (chip: "saved, no reply") → inbox, zero LLM
- `/` → command palette (`/sync`, `/structure`, `/skill`, `/new`)
- skill chip beside input (pick a persona — mentor, therapist by methodology, coach — switch mid-chat)
- Two voice paths, separate: global mic in header = voice memo (Whisper → inbox); in-chat toggle = real-time voice session (ElevenLabs) that logs key points to the record.

## Capture pipeline
Everything lands raw + free in the inbox (pending bucket). Pay the LLM only on the **Structure** button (clean CSV → direct column map, prose → LLM parse). Then optional **Embed** (default-on local). Keyword FTS5 = always-on, free.

## Integrations
- **Tier 1 (official APIs, live sync):** RescueTime, GitHub (commits/day), WHOOP, Google Calendar, Spotify.
- **Tier 2 (file/script importers):** Apple Health, iPhone backup (calls + iMessage + screen-time), WhatsApp/iMessage history, Notion, Chrome/Firefox/Safari history.
- **Tier 3 (needs helper):** live location → OwnTracks; Google Timeline → periodic Takeout.
- Drag-and-drop custom file = escape hatch for any source; the agent structures it.

## Dark mode
Cheap if done up front: semantic color tokens (`--bg`, `--fg`, `--card`, `--border`, `--accent`) with light+dark values, referenced everywhere — never hardcoded hex. Toggle flips the token set. Do it in Loop 1; retrofitting onto hardcoded colors is the only painful path.

---

## Build Loops (15)
Dependency-ordered, magic by Loop 5. Each ships only when its test passes.

1. **Foundation + design tokens (dark mode built in)** — Next/TS, SQLite (Drizzle/better-sqlite3), git-record contract, semantic color tokens (light+dark). *Ships:* app runs, theme toggle flips instantly, 4-tab shell navigates.
2. **Record + schema + rebuild** — git-record format (CSV/JSONL per source) + schema (daily / raw_inbox / sessions) + deterministic rebuild-from-record. *Ships:* rebuild from sample files twice = identical.
3. **First importer end-to-end (GitHub)** — key → fetch → normalize → daily table → git commit. *Ships:* real commits/day in the record.
4. **Agent brain: grounded chat (text) ← MAGIC** — Vercel AI SDK + SQL/FTS tools + mentor skill as system prompt. *Ships:* "why felt off?" cites real numbers.
5. **Chat UI** — 3-zone chat, streaming, grounded rendering (numbers + sparkline). *Ships:* real grounded conversation in the UI.
6. **Smart input modes** — `>>` memo → inbox (no LLM), `/` command palette, skill chip. *Ships:* memo lands in inbox; `/sync` runs; skill switches.
7. **Inbox + Structure** — pending bucket + Structure button (CSV → map, prose → LLM) + drag-drop file. *Ships:* drop raw → Structure → rows in daily table.
8. **Journal (Timeline + Table)** — narrative timeline + TanStack table (show/hide/reorder/resize, saved views). *Ships:* browse life; build a saved "Sleep" view.
9. **Sessions (memory)** — persistence + extract {summary, insights, commitments} + synthesis layer; sessions on the Journal timeline. *Ships:* new session references last session's commitment.
10. **Data tab (sync engine)** — sources list, per-source interval, lazy-sync-on-open, notify-if-stale. *Ships:* "GitHub: daily" auto-syncs on reopen; stale manual source badges.
11. **Integration batch (Tier 1)** — RescueTime, Calendar, Spotify, WHOOP as record-contract plugins. *Ships:* 4+ live sources; cross-source insight in chat.
12. **Local daemon + file importers** — Chrome history + iPhone backup (scripts as subprocess) → commit; cloud replica pulls. *Ships:* file sources auto-sync locally, appear in cloud via git.
13. **Voice** — memo (mic → Whisper → inbox) + session (ElevenLabs real-time, in-chat toggle, logs key points). *Ships:* mic → memo saved; voice session talks back grounded and writes to the record.
14. **Channels (Slack + Telegram)** — bot adapters on cloud daemon: message/voice in → memo/chat → reply out. *Ships:* Telegram DM "why tired?" returns grounded reply; same in Slack.
15. **Embeddings + settings + polish** — sqlite-vec + local model (default-on) + semantic tool; Supabase-style API/CLI bar + Connect-to-Claude-Code (MCP); Settings (BYO key, model pick, skills mgmt); dark-mode QA. *Ships:* "find days that felt like this" works with no key set; MCP connects Claude Code; light + dark clean.

**Shape:** 1-5 grounded chat on real data (the wow) · 6-9 capture + record + memory · 10-12 data breadth + automation · 13-14 voice + channels · 15 embeddings + provider choice + ship.

**Flex:** Slack (14) can jump to ~6 for early tester feedback — the brain works by then and a bot is a thin adapter.
