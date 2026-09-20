# Signing

Local builds are unsigned dev builds. Signed builds happen only in CI
(`.github/workflows/release.yml`), and every signing input is optional.

## Windows code signing

Two options, tried in order; if neither is configured the build continues
unsigned and installers are renamed with a `-unsigned` suffix:

1. **Azure Trusted Signing** (preferred)
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
   - `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`
2. **PFX fallback via jsign**
   - `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD`

Unsigned Windows installers show a SmartScreen warning; that is expected for
dev builds and is the reason CI marks the filename `-unsigned`.

## macOS notarization

Requires all three secrets together:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

If any is missing, notarization is skipped with a CI warning and the dmg is
unsigned (Gatekeeper will warn on first launch; right-click > Open still
works for dev builds).

## Release publishing

- `GITHUB_TOKEN` (automatic) creates the GitHub Release and uploads assets.

## Unsigned-dev vs signed-CI

| Aspect     | Local (`pnpm dist`)       | CI release build               |
| ---------- | ------------------------- | ------------------------------ |
| Signing    | Never                     | When secrets are configured    |
| Notarizing | Never                     | When `APPLE_*` secrets exist   |
| Publishing | Never (`--publish never`) | GitHub Release on tag          |
| Filename   | Plain                     | `-unsigned` suffix if unsigned |
