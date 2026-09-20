# Build

How to produce a local (unsigned) desktop build.

## Prerequisites

- Node >= 22, pnpm 11.25.0, dependencies installed (`pnpm install`).
- The desktop app builds from `apps/desktop` with Vite (`dist/`) plus the
  Electron main/preload bundle (`dist-electron/`).

## Commands

Run from the repo root, or the `apps/desktop` equivalents:

| Command                                        | What it does                             |
| ---------------------------------------------- | ---------------------------------------- |
| `pnpm --filter @ai-desktop/desktop build`      | Typecheck + Vite build (renderer + main) |
| `pnpm --filter @ai-desktop/desktop dist`       | Build + package for the current OS       |
| `pnpm --filter @ai-desktop/desktop dist:win`   | Package for Windows (NSIS x64)           |
| `pnpm --filter @ai-desktop/desktop dist:mac`   | Package for macOS (dmg arm64+x64)        |
| `pnpm --filter @ai-desktop/desktop dist:linux` | Package for Linux (AppImage x64)         |

Under the hood `dist*` runs `electron-builder --config electron-builder.yml`
with `--publish never`, so local builds never upload anything.

## Output

- Packaged installers land in `apps/desktop/release/`.
- Local builds are always **unsigned dev builds**; signed builds only happen
  in CI (see `SIGNING.md`).
- `dist/`, `dist-electron/`, and `release/` are build output and are not
  committed.
