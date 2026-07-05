/**
 * Upload-only data sources — exports you download from an app (a WhatsApp chat
 * dump, a Notion export, a Google Takeout, a Slack/Telegram export) that have no
 * live local file for the daemon to poll. Their Data-tab connect affordance is a
 * per-source Upload/drag-drop that lands the file in the Pending inbox tagged with
 * the source; Structure then turns it into daily rows. Browser-safe (metadata
 * only) so both the server source list and the client row can read it.
 */

export interface UploadSource {
  id: string;
  name: string;
  detail: string; // one-line description when not connected
  accept: string; // file-input accept for the export format
  hint: string; // where to get the export
}

export const UPLOAD_SOURCES: UploadSource[] = [
  {
    id: "whatsapp",
    name: "WhatsApp history",
    detail: "chat export → messages per day",
    accept: ".txt,.zip,text/plain",
    hint: "WhatsApp chat → ⋮ → More → Export chat → Without media. Upload the _chat.txt.",
  },
  {
    id: "notion",
    name: "Notion export",
    detail: "exported pages / database CSV → structured rows",
    accept: ".csv,.md,.txt,text/csv,text/markdown",
    hint: "Notion ⋯ → Export → Markdown & CSV. Upload the CSV (or a page's Markdown).",
  },
  {
    id: "google-timeline",
    name: "Google Timeline",
    detail: "Takeout location history → places per day",
    accept: ".json,application/json",
    hint: "Google Takeout → Location History (Timeline) → JSON. Upload the export.",
  },
  {
    id: "slack",
    name: "Slack export",
    detail: "workspace export → messages per day",
    accept: ".json,.zip,application/json",
    hint: "Slack → Settings → Import/Export Data → Export. Upload a channel's JSON.",
  },
  {
    id: "telegram",
    name: "Telegram export",
    detail: "chat export → messages per day",
    accept: ".json,.html,.txt,application/json",
    hint: "Telegram Desktop → ⋮ → Export chat history → JSON. Upload result.json.",
  },
];

export function uploadSourceById(id: string): UploadSource | undefined {
  return UPLOAD_SOURCES.find((s) => s.id === id);
}
