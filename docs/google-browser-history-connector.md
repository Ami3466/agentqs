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
`src/lib/google-web-scraper.ts` (`GOOGLE_PRESETS`) and surface in the Data tab
under Automated imports. The Data Portability API below stays the target for a
hosted/cloud connector, where a local extension is not available.

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
