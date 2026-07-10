# Google Browser History Connector

This connector is for lifetime browser/search history for any user. It must not
depend on the user's existing local files.

## Inputs

- Google account authorization.
- Requested date range.
- Optional connected storage destination: Google Drive, OneDrive, Dropbox, or
  Box.

## Acquisition Strategy

### Primary: Data Portability API

Use when all conditions are true:

- The user is in a supported region.
- The app has the required OAuth scopes approved.
- The resource is available for that user.

Candidate resources:

- `chrome.history`
- `myactivity.search`
- Other `myactivity.*` resources as needed for the product surface.

Expected behavior:

- Initiate archive job.
- Poll archive state.
- Download signed archive URL.
- Import with the same archive parser used for Takeout.
- Compute coverage.

### Secondary: Guided Takeout Export

Use when Data Portability is unavailable.

Expected behavior:

- Open or deep-link the user to a My Activity-only Takeout export.
- Prefer delivery to connected cloud storage.
- Track state as `export_pending`.
- When the archive appears in connected storage, download/import it.
- If Google requires account verification, show `reauth_required` and wait for
  the user to finish in the browser.

### Fallback: Local Upload/Drop

Use only when the user already has a Takeout archive.

Expected behavior:

- Accept a Takeout zip.
- Parse My Activity, Chrome, Timeline, Fit, Calendar, and Maps files where
  present.
- Compute coverage and gaps.

## What Ships Today

The shipped path is the local Chrome extension
(`extensions/google-activity-exporter`): the user's own authenticated Chrome
session reads My Activity through the page's data feed and posts batches to the
local AgentQS server. Presets are defined once in
`src/lib/google-web-scraper.ts` (`GOOGLE_PRESETS`) and surface in the Pipeline tab
under Automated imports. The Data Portability API below stays the target for a
hosted/cloud connector, where a local extension is not available.

A walk over a lifetime account takes hours, so the run is built to survive
anything short of a Google sign-out without user action:

- Every page saves a continuation checkpoint to the page's localStorage AND to
  `chrome.storage.local` (the background worker's copy).
- A background watchdog (1-minute alarm + Chrome startup hook) reopens or
  reloads the Google tab whenever the checkpoint says "running" but status has
  gone quiet for 5 minutes — this covers computer shutdown/restart, Chrome
  restart, Memory-Saver tab discards, and frozen pages. The content script
  auto-resumes from the checkpoint when the page loads.
- If a resumed continuation token has expired, the walk restarts from the top
  automatically; the server dedups events, so already-imported pages just
  fast-forward (`added: 0`).
- Batch posts and heartbeat pings rotate through the app port and the
  standalone ingest listener (`src/lib/ingest-server.ts`, port 3033), so dev
  recompiles or a squatted port never abort a run.
- Pause (page panel) or Stop import (popup) marks the checkpoint not-running,
  which stands the watchdog down; Start import resumes from the checkpoint.
- Sign-out and other user-action errors are permanent: the run stops with an
  explanatory status instead of retrying forever.

## Non-Goals

- Server-side scraping of `myactivity.google.com` (headless/Playwright) as the
  normal production path.
- Reading private Chrome Sync databases.
- Reading browser password stores.
- Asking users to paste Google credentials.
- Claiming Chrome local history is lifetime history.

## Browser-History Completion Criteria

For a requested range, the connector is complete only when:

- The imported source includes My Activity or Data Portability browser/search
  data.
- The largest gap is below the configured tolerance.
- The status command reports `complete_enough`.

Current status command:

```bash
npx tsx scripts/google-ingestion-status.ts --check-takeout
```
