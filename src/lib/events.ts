import fs from "fs";
import { openReadonly } from "./db";
import { dbPath } from "./paths";
import type { JournalEvent } from "./journal";

export interface EventsRangeResult {
  events: JournalEvent[];
  total: number;
  limit: number;
}

function parseMeta(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function readEventsRange(start: string, end: string, limit = 500, file: string = dbPath()): EventsRangeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("Invalid date range.");
  }
  if (!fs.existsSync(file)) return { events: [], total: 0, limit };
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
  const capped = Math.max(1, Math.min(2000, requested));
  const db = openReadonly(file);
  try {
    const total = (db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE date >= ? AND date <= ?")
      .get(start, end) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT id, date, ts, source, title, text, url, meta
         FROM events
         WHERE date >= ? AND date <= ?
         ORDER BY ts, id
         LIMIT ?`,
      )
      .all(start, end, capped) as Array<{
      id: string;
      date: string;
      ts: string;
      source: string;
      title: string | null;
      text: string;
      url: string | null;
      meta: string | null;
    }>;
    return {
      total,
      limit: capped,
      events: rows.map((e) => ({
        id: e.id,
        date: e.date,
        ts: e.ts,
        source: e.source,
        title: e.title,
        text: e.text,
        url: e.url,
        meta: parseMeta(e.meta),
      })),
    };
  } catch (e) {
    if (String((e as Error).message).includes("no such table")) return { events: [], total: 0, limit: capped };
    throw e;
  } finally {
    db.close();
  }
}
