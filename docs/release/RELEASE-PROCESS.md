# Release process

Releases are cut from version tags and run entirely in CI
(`.github/workflows/release.yml`, workflow name `Release`).

## Cutting a release

1. Ensure `main` is green (CI runs typecheck, lint, architecture:check,
   security:check, test, build).
2. The main session bumps the version; this flow keeps `0.0.0` locally.
3. Push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`
   (or run the workflow manually via `workflow_dispatch`).
4. CI runs three stages:
   - **validate** (ubuntu): install, typecheck, lint, architecture:check,
     security:check, test, build. Any failure stops the release (fail closed).
   - **build** (matrix: windows-latest, macos-latest, ubuntu-latest):
     package with `--publish never`, generate `.sha256` sidecars
     (`scripts/release/checksums.mjs`), validate
     (`scripts/release/artifact-validation.mjs`), upload artifacts.
   - **publish** (ubuntu, needs validate + build): download all artifacts,
     build `manifest.json` (`scripts/release/release-manifest.mjs`),
     create the GitHub Release with all files
     (`softprops/action-gh-release`).

## Verification scripts

| Script                    | Command                                                                                                              | Purpose                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `checksums.mjs`           | `node scripts/release/checksums.mjs <dir>`                                                                           | Write sibling `.sha256` files (`<hash>  <filename>`) for every artifact                           |
| `artifact-validation.mjs` | `node scripts/release/artifact-validation.mjs <dir> [--app-version X]`                                               | Fail-closed gate: installer present, checksums verify, update manifest parses, installers > 20 MB |
| `release-manifest.mjs`    | `node scripts/release/release-manifest.mjs --dir <d> --version <v> --channel <c> --repo <o/r> [--out manifest.json]` | Emit the JSON release manifest consumed by the GitHub Release                                     |

## Manifest format

`manifest.json` is a JSON array of
`{ version, channel, repository, platform, arch, artifact, sha256, size, releaseDate }`.
`platform` is inferred from the extension (`exe` -> `win`, `dmg`/`zip` ->
`mac`, `AppImage` -> `linux`); `arch` from the filename (default `x64`).
