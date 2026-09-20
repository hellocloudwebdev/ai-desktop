# PR47 — Packaging, Updater & Production Release

## 1. Objective

PR47 turns the hardened AI Desktop application into a reproducible, installable, signed, and updateable production desktop application without introducing a second runtime or altering constitutional architecture.

```text
Source
  ↓
Dependency validation (architecture:check)
  ↓
Typecheck / Lint / Tests / Security gates (security:check)
  ↓
Production build (vite build renderer + main + preload)
  ↓
Package (electron-builder: NSIS x64, macOS DMG, Linux AppImage)
  ↓
Artifact validation (artifact-validation.mjs: size, sidecars, manifests)
  ↓
Code signing (Azure Trusted Signing / jsign fallback / Apple Notarization)
  ↓
Release metadata & Checksums (checksums.mjs: SHA-256 sidecars)
  ↓
Update manifest (release-manifest.mjs: JSON manifest)
  ↓
Published release (GitHub Release on tag)
  ↓
Installed Desktop App (first-run directory initialization, migration checks)
  ↓
Secure Update (SecureUpdateService: HTTPS, host allowlist, sha256 verify)
```

The release system works deterministically and fails closed when an artifact or feed is invalid.

---

## 2. Inviolable Constitutional Guarantees

PR47 upholds all normative rules from `docs/architecture/CONSTITUTION.md`:

1. **Process Isolation:** All packaging and release configuration resides in `apps/desktop` and `scripts/release/`. Packages under `packages/*` remain completely Electron-agnostic.
2. **Storage Isolation:** SQLite database files and Prisma migrations reside in the versioned app data directory (`databases/`) and storage repositories interact with them through `StorageDatabase`. No Prisma imports leak into release or updater code.
3. **Provider Isolation:** Provider credentials are never bundled into release artifacts or configuration files.
4. **Permission Invariants:** Update payloads cannot disable `PermissionManager`, overwrite trust configurations, or inject arbitrary renderer execution.
5. **Fail-Closed Updates:** Update feeds must use HTTPS and belong to allowlisted domains. Artifacts must match expected extensions and SHA-256 checksums before staging.
6. **Data Preservation:** User data directories and databases survive application upgrades and uninstalls (`deleteAppDataOnUninstall: false`). Migrations are versioned, idempotent, and back up previous states on error.

---

## 3. Production Build Architecture

- **Bundler:** Vite + Rolldown/ESBuild compiles renderer (`dist/`), main process, and preload scripts (`dist-electron/`).
- **Pruning:** Source maps (`*.map`), test fixtures, and development dependencies are excluded from production ASAR archives.
- **Resources:** Prisma schema and migration folders are bundled into `extraResources` for production database operations.
- **Environment Separation:** `production-config.ts` enforces `NODE_ENV === "production"`, rejecting development server URLs (`VITE_DEV_SERVER_URL`), debug flags (`DEBUG`), and secret keys at startup.

---

## 4. Application Identity

The packaged application maintains a stable cross-platform identity:

- `appId`: `com.aidesktop.app`
- `productName`: `AI Desktop`
- `executableName`: `aidesktop`
- `protocol`: `aidesktop`
- `channel`: `stable`

---

## 5. Platform Packaging & Targets

Targets are locked to canonical platforms:

- **Windows:** NSIS installer (`x64`), per-user installation (`perMachine: false`), custom directory support, user data preserved on uninstall.
- **macOS:** DMG (`arm64`, `x64`), Productivity category.
- **Linux:** AppImage (`x64`), Utility category.

---

## 6. Secure Update Architecture

Implemented by `SecureUpdateService`, `update-feed.ts`, `update-types.ts`, and `update-ipc.ts`:

- **Protocol:** HTTPS-only (`https://github.com/...`).
- **Host Allowlist:** `github.com`, `objects.githubusercontent.com`, `releases.githubusercontent.com`.
- **Integrity:** SHA-256 validation before transitioning update state to `ready`.
- **Lifecycle:** `idle` → `checking` → `available` → `downloading` → `verifying` → `ready` → `installing` → `updated` / `up-to-date` / `failed`.
- **IPC Safety:** Narrow typed IPC bridge (`updates:check`, `updates:download`, `updates:install`, `updates:state`). No arbitrary code execution or download channels.
- **UI Surface:** `UpdateBanner.tsx` provides status feedback and action buttons without exposing internal error stack traces.

---

## 7. Versioning & Release Verification Tooling

- **Release Scripts:**
  - `scripts/release/checksums.mjs`: Generates SHA-256 sidecars (`.sha256`) for release installers.
  - `scripts/release/artifact-validation.mjs`: Enforces installer presence, minimum installer size (> 20 MB), checksum verification, and update manifest validity.
  - `scripts/release/release-manifest.mjs`: Emits structured JSON release metadata (`version`, `channel`, `platform`, `arch`, `artifact`, `sha256`, `size`, `releaseDate`).
- **CI/CD Pipeline (`.github/workflows/release.yml`):**
  - Validation gate: `typecheck`, `lint`, `architecture:check`, `security:check`, `test`, `build`.
  - Matrix build: Windows, macOS, Linux packaging.
  - Code signing: Azure Trusted Signing / PFX fallback on Windows; Apple Notarization on macOS.
  - GitHub Release creation with signed artifacts, sidecars, and manifests.
