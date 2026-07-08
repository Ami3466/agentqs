# Google Lifetime Data Workaround

Goal: get as much lifetime Google data as possible onto the local machine and into
AgentQS without relying on Chrome's local history database.

For the production-level ingestion architecture, see
[google-production-ingestion.md](google-production-ingestion.md).

## What Works Globally

1. Scan local disks for existing Takeout archives and import all usable archives.
   People often have older Takeouts in Downloads, Drive sync, OneDrive sync, or old
   backup folders.

   ```bash
   npx tsx scripts/import-google-lifetime.ts
   ```

   The current archive importer extracts My Activity, old Maps Timeline semantic
   location history, derived Google Fit daily metrics, Google Calendar ICS daily
   event counts, and Maps saved places/reviews.

2. For gaps, request a narrow Takeout for the missing product instead of a full
   account export. For browsing/search history, use a My Activity-only export.
   Re-run the importer after the zip lands locally.

   Check a pending Takeout tab without opening more browser tabs:

   ```bash
   npx tsx scripts/check-google-takeout.ts --expect "My Activity"
   ```

   When the export is ready, this can click the visible Takeout download link,
   wait for a new zip in Downloads, and rerun the lifetime importer:

   ```bash
   npx tsx scripts/check-google-takeout.ts --expect "My Activity" --download --import
   ```

   To keep polling the existing Takeout tab until Google finishes:

   ```bash
   npx tsx scripts/check-google-takeout.ts --expect "My Activity" --watch --refresh --interval-seconds 300 --download --import
   ```

   Google may require fresh authentication before downloading a Takeout archive.
   In that case the checker prints `status=reauth_required`. Complete the
   passkey/password prompt in Chrome itself; do not paste account secrets into a
   terminal or chat. The watcher will notice the new zip in Downloads and import
   it.

3. For Maps Timeline after Google's local-device migration, export from the phone:
   Android Settings -> Location -> Location services -> Timeline -> Export Timeline data,
   or Google Maps on iOS -> Settings -> Location & Privacy -> Export Timeline data.
   Put the JSON in Downloads and run the same lifetime importer.

4. For users in supported countries, use the Google Data Portability API for a
   productized import flow. It supports Chrome history, Maps, Search, YouTube, and
   related My Activity resources, with optional time filters and signed download URLs.
   It requires OAuth, Google app approval, and country availability.

## Limits

- Chrome local history is not lifetime history. Google's Chrome help says the
  browser history UI lists pages visited in the last 90 days.
- Google Data Portability is not globally available. As of the checked Google help
  page, the United States is not listed; Google points unsupported users back to
  Takeout.
- Takeout does not support arbitrary time-window exports for every product. Use
  product-specific exports to reduce failures and archive size.
- New Maps Timeline data may live on-device. The phone export is the practical
  source for post-migration Timeline data.

## Current Local Coverage

Run:

```bash
npx tsx scripts/import-google-lifetime.ts --dry-run
```

This prints discovered archives and current AgentQS coverage without changing data.

Sources checked:
- https://support.google.com/accounts/answer/3024190
- https://support.google.com/accounts/answer/14452558
- https://developers.google.com/data-portability
- https://developers.google.com/data-portability/user-guide/introduction
- https://developers.google.com/data-portability/reference/rest/v1/portabilityArchive/initiate
- https://support.google.com/chrome/answer/95589
- https://support.google.com/maps/answer/6258979
