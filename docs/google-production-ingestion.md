# Production Google Data Ingestion

This is the production approach for getting lifetime Google data into AgentQS for
any user. It avoids assuming the user already has old archives on disk, avoids
bypassing Google auth, and avoids private browser internals or fragile scraping
as the primary path.

For the browser-history-specific connector contract, see
[google-browser-history-connector.md](google-browser-history-connector.md).

## Browser History Source Priority

1. Data Portability API, where available.
   - Use OAuth and Google-approved scopes.
   - Relevant scopes include Chrome and My Activity Search resources.
   - This is the best productized flow, but Google limits availability by
     country/region and app approval status.

2. User-initiated Google Takeout My Activity export.
   - Use for users outside Data Portability availability or while the app is not
     approved for the needed scopes.
   - The product must guide the user to request a narrow `My Activity` export,
     preferably delivered to Drive, OneDrive, Dropbox, or Box so the app can
     ingest the resulting archive through a normal connected-storage integration.
   - Email-link downloads are acceptable, but they often require fresh Google
     verification at download time.
   - Google may require fresh user verification before download. The app must
     surface this as `reauth_required`, not attempt to bypass it.

3. Google Takeout Chrome export.
   - Good for Chrome-specific browser history present in Takeout.
   - It may not equal lifetime Web & App Activity.

4. Local Chrome History database.
   - Fallback only.
   - Useful for immediate local state and browser-only activity.
   - Not a lifetime source.

5. Local archive discovery.
   - Import-only fallback, not acquisition.
   - Useful for power users or migrations, but not the default production path.

## Other Google Data Sources

The current production importer supports these local official exports:

- My Activity Takeout HTML
- Chrome Takeout `History.json`
- Maps Timeline semantic history from older Takeout archives
- Phone Timeline JSON export after Google's on-device Timeline migration
- Google Fit derived JSON daily metrics
- Google Calendar `.ics` event counts
- Maps saved places and reviews
- Access log activity CSV

## Product State Machine

For browser history, the product should show one of these states:

- `complete_enough`: imported data covers the requested date range.
- `needs_google_connection`: no Google account authorization/export path is active.
- `api_unavailable`: Data Portability cannot be used for this user/app/region.
- `needs_takeout`: no suitable Takeout/Data Portability archive has been created.
- `export_pending`: a Takeout export has been requested but is not ready.
- `reauth_required`: Google finished the export, but the user must complete
  Google verification in the browser before the archive can be downloaded.
- `ready_to_import`: a new Takeout archive is present locally and has not been
  imported yet.
- `imported_with_gaps`: data imported, but coverage still has significant gaps.

## Production Browser-History Flow

1. Ask the user to connect Google.
2. Check if Data Portability is available for the account, requested scopes, app
   approval status, and user region.
3. If available, initiate a Data Portability archive for:
   - `chrome.history`, when available for the user.
   - `myactivity.search` and other relevant My Activity resources.
4. If unavailable, start a guided Takeout flow:
   - Product: `My Activity`.
   - Include all activity data.
   - Prefer delivery to a connected cloud storage provider rather than email.
   - Poll the connected destination for the resulting archive.
5. Import the archive, then compute coverage gaps.
6. If gaps remain, show them explicitly and offer a second export/import cycle.

The production product should treat Takeout as an official export transport, not
as a random file upload feature. The user-visible action is "connect Google /
create export"; the archive parser is an implementation detail.

## Commands

Audit local Google coverage:

```bash
npx tsx scripts/google-ingestion-status.ts
```

Import all local Google archives and phone Timeline exports:

```bash
npx tsx scripts/import-google-lifetime.ts
```

Check the existing Takeout tab:

```bash
npx tsx scripts/check-google-takeout.ts --expect "My Activity"
```

Download and import a ready Takeout export after user auth:

```bash
npx tsx scripts/check-google-takeout.ts --expect "My Activity" --download --import
```

Watch for completion and import automatically after the user completes Google
auth in Chrome:

```bash
npx tsx scripts/check-google-takeout.ts --expect "My Activity" --watch --refresh --interval-seconds 300 --download --import
```

## Security Rules

- Never ask users to paste Google passwords into AgentQS, terminal, logs, or chat.
- Never read browser password stores.
- Never bypass Google re-authentication.
- Treat Google Takeout links as sensitive.
- Store raw archives locally only; do not upload them without explicit user action.
- Record imported daily aggregates and keep raw CSV extracts under local `tmp/`.

## Official References

- Google Takeout: https://support.google.com/accounts/answer/3024190
- Data Portability API: https://developers.google.com/data-portability
- Data Portability scopes: https://developers.google.com/data-portability/user-guide/scopes
- Data Portability availability: https://support.google.com/accounts/answer/14452558
- Chrome history help: https://support.google.com/chrome/answer/95589
