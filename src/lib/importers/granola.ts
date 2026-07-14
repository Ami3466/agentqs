import {
  attendeeNames,
  countWords,
  discoverGranolaRefreshToken,
  getGranolaPanels,
  getGranolaTranscript,
  granolaAccessToken,
  isMeeting,
  listGranolaDocuments,
  meetingMinutes,
  meetingNotes,
  meetingTitle,
  transcriptToText,
  type GranolaDoc,
  type GranolaPanel,
  type GranolaTranscriptSegment,
} from "../granola";
import {
  inWindow,
  type DailyTable,
  type ImporterContext,
  type ImporterEvent,
  type ImporterPlugin,
  type ImporterResult,
} from "./plugin";

/**
 * Granola — meetings, AI notes and transcripts.
 *
 * Auth is the desktop client's refresh token, picked up off this machine
 * automatically (`discoverCredential`) so the source connects with nothing to
 * paste. Each meeting lands three ways, because each is read differently:
 *
 *   record/daily/granola.csv        meetings · minutes · words   (graphs, sparkline)
 *   record/daily/granola_texts.csv  the day's notes as prose     (search + embeddings)
 *   record/events.jsonl             one event per meeting        (journal timeline)
 *
 * Events carry the verbatim transcript in `meta.transcript` — the full-resolution
 * copy — while the journal text stays the readable AI summary.
 */

/** Journal text stays readable; the transcript in `meta` keeps full resolution. */
const MAX_EVENT_TEXT = 4000;

/** A Granola document the importer has fully resolved (notes + transcript fetched).
 *  `meeting` separates something that actually happened from a note Granola keeps
 *  alongside it — both are indexed, only one counts as a meeting. */
interface Doc {
  doc: GranolaDoc;
  date: string;
  ts: string;
  title: string;
  notes: string;
  transcript: string;
  meeting: boolean;
  minutes: number;
  words: number;
  attendees: string[];
  url: string | null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** Wide daily table: one row per day Granola holds anything for. `notes` is its own
 *  column so a notes-only day still shows up rather than vanishing from the graphs. */
export function granolaDailyTable(docs: Doc[]): DailyTable {
  const byDate = new Map<string, { meetings: number; notes: number; minutes: number; words: number }>();
  for (const d of docs) {
    const agg = byDate.get(d.date) ?? { meetings: 0, notes: 0, minutes: 0, words: 0 };
    if (d.meeting) {
      agg.meetings += 1;
      agg.minutes += d.minutes;
    } else {
      agg.notes += 1;
    }
    agg.words += d.words;
    byDate.set(d.date, agg);
  }
  const rows = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, a]) => [date, String(a.meetings), String(a.notes), String(a.minutes), String(a.words)]);
  return { header: ["date", "meetings", "notes", "minutes", "words"], rows };
}

/** `date,chars,text` — the searchable prose column the journal importers all use.
 *  One cell per day, every document that day stacked under its own heading. */
export function granolaTextsTable(docs: Doc[]): DailyTable {
  const byDate = new Map<string, string[]>();
  for (const d of docs) {
    const body = d.notes || d.transcript;
    if (!body) continue;
    const time = d.ts.slice(11, 16);
    const who = d.attendees.length ? ` · with ${d.attendees.join(", ")}` : "";
    const head = `# ${d.title} (${time}${d.minutes ? `, ${d.minutes} min` : ""}${who})`;
    byDate.set(d.date, [...(byDate.get(d.date) ?? []), `${head}\n${body}`]);
  }
  const rows = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, parts]) => {
      const text = parts.join("\n\n");
      return [date, String(text.length), text];
    });
  return { header: ["date", "chars", "text"], rows };
}

/** One event per document. The Granola document id makes it idempotent: re-syncing
 *  a renamed or re-summarized meeting updates nothing and duplicates nothing. */
export function granolaEvents(docs: Doc[]): ImporterEvent[] {
  return docs.map((d) => ({
    id: `granola:${d.doc.id}`,
    date: d.date,
    ts: d.ts,
    title: d.title,
    text: clip(d.notes || d.transcript || d.title, MAX_EVENT_TEXT),
    url: d.url,
    meta: {
      doc_id: d.doc.id,
      kind: d.meeting ? "meeting" : "note",
      minutes: d.minutes,
      words: d.words,
      attendees: d.attendees,
      ...(d.transcript ? { transcript: d.transcript } : {}),
    },
  }));
}

/**
 * A meeting with no recording really has no panels and no transcript — Granola answers
 * 404/empty and that is the truth. Anything else (500, a network blip, a rate limit) is
 * NOT the truth, it is the absence of one, and treating it as "this meeting is empty"
 * deletes a meeting that exists. Empty on a real absence; throw on everything else.
 */
function emptyOrThrow<T>(docId: string, what: string): (e: unknown) => T[] {
  return (e: unknown) => {
    const msg = (e as Error)?.message ?? String(e);
    if (/\b404\b/.test(msg)) return []; // the document genuinely has none
    throw new Error(
      `Granola ${what} for document ${docId} → ${msg}. Refusing to treat a failed request as an empty meeting: ` +
        "this source REPLACES its events on every sync, so that would delete the meeting and its transcript from your record.",
    );
  };
}

export const granolaPlugin: ImporterPlugin = {
  id: "granola",
  name: "Granola",
  detail: "meetings, notes & transcripts",
  live: true,
  // The desktop app's login is discovered off this machine, so a signed-in user
  // connects with nothing to paste — but a pasted refresh token works everywhere.
  requiresCredential: false,
  credentialLabel: "Granola refresh token",
  credentialPlaceholder: "refresh token from Granola's supabase.json",
  // Detection only works when agentqs runs on the SAME machine as the desktop app.
  // A hosted instance can never see that file, so the guide must lead with the
  // paste path — promising "we detect it" to a server that physically cannot is
  // how this row read as broken in production.
  credentialHelp: {
    url: "https://granola.ai",
    steps: [
      "Granola issues no API keys — the credential is the desktop app's own refresh token.",
      "On the machine where Granola is signed in, open ~/Library/Application Support/Granola/supabase.json (Windows: %APPDATA%\\Granola\\supabase.json — Linux: ~/.config/Granola/supabase.json).",
      "Copy the workos_tokens.refresh_token value out of it and paste it here.",
      "Running agentqs on that same machine? It finds the login itself — the button then reads \"Connect (use detected app)\" and there is nothing to paste.",
    ],
  },
  envKey: "GRANOLA_REFRESH_TOKEN",
  primaryMetric: "meetings",
  unit: "meetings",
  // A meeting's AI notes/summary are regenerated after it ends, so a re-sync must
  // refresh its events rather than keep the first (maybe empty) copy.
  mutableEvents: true,
  discoverCredential: discoverGranolaRefreshToken,

  async fetch(ctx: ImporterContext): Promise<ImporterResult> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const refreshToken = ctx.credential;
    if (!refreshToken) {
      throw new Error(
        "No Granola credential. The desktop app's login is only visible to an agentqs running on the SAME machine — " +
          "on a hosted instance, paste the refresh token from Granola's supabase.json (workos_tokens.refresh_token).",
      );
    }

    let token: string;
    try {
      token = await granolaAccessToken(refreshToken, fetchImpl);
    } catch (e) {
      throw new Error(`Granola sign-in → ${(e as Error).message}`);
    }

    let docs: GranolaDoc[];
    try {
      docs = await listGranolaDocuments(token, fetchImpl);
    } catch (e) {
      throw new Error(`Granola get-documents → ${(e as Error).message}`);
    }

    const windowed = docs.filter((d) => {
      const created = (d.created_at ?? "").slice(0, 10);
      return created && inWindow(created, ctx.from, ctx.to);
    });

    const resolved: Doc[] = [];
    for (const doc of windowed) {
      // Notes and transcript are per-document endpoints; a missing one is NORMAL (a
      // meeting you never recorded) and must not fail the whole sync.
      //
      // But "the endpoint says there is nothing" and "the request failed" are not the
      // same fact, and swallowing both as `[]` made a blip DESTRUCTIVE. Granola is a
      // `mutableEvents` source: a sync REPLACES its events across the window. So one
      // 500 on get-document-panels meant the meeting resolved to nothing, was dropped
      // from `resolved`, and its event — with the verbatim transcript in its meta —
      // was DELETED from events.jsonl and never re-added. The daily table then wrote
      // `meetings=1` over the `2` that was there. A dropped API call silently rewrote
      // history downward, and the sync reported ok.
      //
      // A failed sync is recoverable. A deleted transcript is not. So a real failure
      // now fails LOUDLY, and only a genuinely absent panel/transcript reads as empty.
      const [panels, segments] = await Promise.all([
        getGranolaPanels(doc.id, token, fetchImpl).catch(emptyOrThrow<GranolaPanel>(doc.id, "notes")),
        getGranolaTranscript(doc.id, token, fetchImpl).catch(emptyOrThrow<GranolaTranscriptSegment>(doc.id, "transcript")),
      ]);
      const transcript = transcriptToText(segments);
      const notes = meetingNotes(doc, panels);
      if (!transcript && !notes) continue; // an empty stub — nothing to index
      const ts = doc.created_at ?? `${ctx.to}T00:00:00.000Z`;
      resolved.push({
        doc,
        date: ts.slice(0, 10),
        ts,
        title: meetingTitle(doc),
        notes,
        transcript,
        meeting: isMeeting(doc, segments),
        minutes: meetingMinutes(doc, segments),
        words: countWords(transcript),
        attendees: attendeeNames(doc),
        url: doc.google_calendar_event?.htmlLink ?? null,
      });
    }

    const meetings = resolved.filter((d) => d.meeting).length;
    return {
      table: granolaDailyTable(resolved),
      extraTables: { texts: granolaTextsTable(resolved) },
      events: granolaEvents(resolved),
      meta: { documents: docs.length, meetings, notes: resolved.length - meetings },
    };
  },
};
