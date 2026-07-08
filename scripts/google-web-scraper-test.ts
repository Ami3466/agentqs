#!/usr/bin/env tsx
import { extractGoogleEventsFromBlocks } from "../src/lib/google-web-scraper";

const blocks = [
  "Search\nSearched for agentqs browser history\nJul 6, 2026, 00:03",
  "Search\nVisited https://example.com/docs\nJul 6, 2026, 00:04",
  "Maps\nViewed place Home\nApr 30, 2026, 13:03",
  "Sign in - Google Accounts",
];

const events = extractGoogleEventsFromBlocks(blocks, "browser_history", new Date("2026-07-07T00:00:00Z"));
console.log(JSON.stringify({ events: events.length, first: events[0], last: events.at(-1) }, null, 2));
if (events.length !== 3) throw new Error(`Expected 3 events, got ${events.length}`);
if (events[0].date !== "2026-07-06") throw new Error(`Bad parsed date: ${events[0].date}`);
if (!events.some((e) => e.url === "https://example.com/docs")) throw new Error("URL extraction failed.");
