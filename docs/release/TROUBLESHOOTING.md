# Troubleshooting

## `artifact-validation.mjs` fails

| Failure                    | Likely cause                                            | Fix                                                                                           |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `installer-present` FAIL   | `release/` empty or builder failed silently             | Check the `Package (publish never)` CI step log; run `pnpm dist` locally                      |
| `sha256:*` missing sidecar | Skipped the checksums step                              | Run `node scripts/release/checksums.mjs apps/desktop/release` first                           |
| `sha256:*` mismatch        | Artifact rebuilt or edited after hashing                | Re-run checksums, then re-validate                                                            |
| `update-manifest` FAIL     | No `latest.yml`, or missing `version:` / `url:` entries | Ensure builder ran with the `publish` section intact; do not delete `*.yml` before validation |
| `size:*` FAIL (< 20 MB)    | Incomplete bundle, missing `dist/`                      | Run a clean `pnpm build` before `pnpm dist`                                                   |

## Signing / notarization warnings

- `No Windows signing secrets ... marking artifacts -unsigned`: expected
  without `AZURE_*` / `WIN_CERT_*` secrets; rename is intentional, not an error.
- `APPLE_* ... not set; skipping notarization`: expected for dev builds;
  add all three secrets to get notarized macOS builds.

## CI release never publishes

- The `publish` job `needs: [validate, build]` with `fail-fast: true`: any
  gate failure stops publishing by design. Inspect the failed job, fix, and
  push a new patch tag (tags are immutable; do not re-push the same tag).
- `workflow_dispatch` runs use version `0.0.0-dev` and still upload artifacts
  for inspection but the GitHub Release step needs a tag context.

## Windows SmartScreen / macOS Gatekeeper blocks unsigned build

Expected for unsigned builds (see `SIGNING.md`): Windows > "More info" >
"Run anyway"; macOS > right-click > Open. For distribution, configure the
signing secrets and cut a signed CI release.
