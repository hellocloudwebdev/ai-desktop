# Updates

Auto-updates are delivered by `electron-updater` (already a dependency of
`apps/desktop`, v6.8.9) against the GitHub Release published by CI.

## How it works

1. CI publishes installers plus the electron-builder update manifests
   (`latest.yml` / `latest-*.yml`) to the GitHub Release.
2. The shipped app checks that release (provider `github`, channel `stable`
   per `electron-builder.yml`) for a newer `version`.
3. When found, the update downloads in the background and installs on quit
   (NSIS per-user installer preserves userData; see `PACKAGING.md`).

## Channels

- `stable` is the only channel currently configured.
- `scripts/release/release-manifest.mjs` also accepts `beta` / `nightly`
  channels for future use; they have no CI wiring yet.

## Rollback limits

`electron-updater` has **no automatic rollback**:

- A downgrade requires shipping a new release with a higher version number
  (electron-updater never installs an older version over a newer one).
- If a release is broken, the fix is a new patch release, not deleting the
  GitHub Release (deleting breaks clients that already saw it).
- User data is never touched by updates or uninstalls
  (`deleteAppDataOnUninstall: false`), so a bad release cannot wipe data —
  but a bad schema migration can still require manual recovery; test
  migrations before tagging.
