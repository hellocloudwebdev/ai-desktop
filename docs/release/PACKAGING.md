# Packaging

electron-builder configuration lives in `apps/desktop/electron-builder.yml`.

## Identity

- `appId`: `com.aidesktop.app`
- `productName`: `AI Desktop`
- `executableName`: `aidesktop`
- `asar`: `true`

## Files bundled

- `dist/**` (renderer), `dist-electron/**` (main + preload), `package.json`.
- `*.map` files are excluded.
- `node_modules` are pruned to production dependencies automatically.
- `extraResources` ships `prisma/schema.prisma` and `prisma/migrations/**`
  into the app resources (resolved from `../../prisma/...` relative to
  `apps/desktop`).

## Targets

| Platform | Target   | Arch      | Notes                                             |
| -------- | -------- | --------- | ------------------------------------------------- |
| Windows  | NSIS     | x64       | `oneClick: false`, `perMachine: false` (per-user) |
| macOS    | dmg      | arm64+x64 | `category: public.app-category.productivity`      |
| Linux    | AppImage | x64       | `category: Utility`                               |

## Uninstall / upgrade data safety

- `nsis.deleteAppDataOnUninstall` is `false`: uninstalling never deletes the
  user's data directory.
- Per-user install (`perMachine: false`) means upgrades preserve userData in
  place; there is no data migration step in the installer.

## Publishing

- The `publish` section (provider `github`, owner `hellocloudwebdev`, repo
  `ai-desktop`, channel `stable`) is used **only by the CI release workflow**
  (`.github/workflows/release.yml`). Local `dist*` builds pass
  `--publish never`.
- No secrets are stored in `electron-builder.yml`.
