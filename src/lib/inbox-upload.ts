/**
 * Shared client-side upload path into the Pending inbox. One place owns "read a
 * dropped/picked text file → POST /api/inbox", used by both the Inbox panel's
 * Upload/drag-drop and a Data-tab source row's per-source upload (a WhatsApp/Notion/
 * Takeout export lands here tagged with the source, then Structure turns it into
 * daily rows). Browser-safe (fetch only, no fs).
 */

/** Accept string for text/CSV/JSON exports the inbox can ingest today. */
export const INBOX_TEXT_ACCEPT = ".csv,.tsv,.tab,.psv,.txt,.md,.json,.log,text/*,application/json";

const TEXT_EXT = /\.(csv|tsv|tab|psv|txt|md|json|log)$/i;

export function isTextFile(f: File): boolean {
  return f.type.startsWith("text/") || f.type === "application/json" || TEXT_EXT.test(f.name);
}

export function kindOf(name: string): string {
  return /\.(csv|tsv|tab|psv)$/i.test(name) ? "csv" : "file";
}

export interface UploadOutcome {
  added: number;
  /** Human-readable reasons files were skipped (non-text, empty, failed POST). */
  skipped: string[];
}

/**
 * Upload each text file into the inbox tagged with `source`. Non-text/empty files
 * are skipped with a reason. Returns a tally so the caller can flash one message.
 */
export async function uploadFilesToInbox(
  files: FileList | File[],
  source = "drop",
): Promise<UploadOutcome> {
  const list = Array.from(files);
  const out: UploadOutcome = { added: 0, skipped: [] };
  for (const f of list) {
    if (!isTextFile(f)) {
      out.skipped.push(`${f.name} — text/CSV/JSON only for now`);
      continue;
    }
    const text = await f.text();
    if (!text.trim()) {
      out.skipped.push(`${f.name} — empty file`);
      continue;
    }
    const res = await fetch("/api/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        source,
        kind: kindOf(f.name),
        meta: { filename: f.name, bytes: f.size },
      }),
    });
    if (res.ok) out.added += 1;
    else out.skipped.push(`${f.name} — upload failed`);
  }
  return out;
}
