// apps/desktop — Release application data directory + versioned migrations.
//
// Owns the per-user data directory layout and the versions.json record that
// tracks schema generations. Rules:
//   - The Electron `app` module is the only Electron import in the release
//     area. Every access is guarded: when Electron is unavailable (tests,
//     scripts, app not ready) resolution falls back to a tmpdir path.
//   - Migrations are ordered, idempotent, and atomic at the versions.json
//     boundary: the record is rewritten only after every pending migration
//     succeeds. A failure preserves the prior record, keeps a backup copy,
//     and never deletes user data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { app } from "electron";
import { getAppDataDirName } from "./app-identity.js";

/** Subdirectories owned by the data directory layout (v1). */
export const APP_DATA_SUBDIRS = ["documents", "skills", "extensions", "backups", "logs"] as const;

export type AppDataSubdir = (typeof APP_DATA_SUBDIRS)[number];

export const VersionsFileSchema = z.object({
  appVersion: z.string().trim().min(1).max(64),
  schemaVersion: z.number().int().min(0).max(999),
  configVersion: z.number().int().min(0).max(999),
  workspaceStateVersion: z.number().int().min(0).max(999),
  syncStateVersion: z.number().int().min(0).max(999),
});

export type VersionsFile = z.infer<typeof VersionsFileSchema>;

/** Current generation for a freshly initialized data directory. */
export const CURRENT_VERSIONS = {
  schemaVersion: 1,
  configVersion: 1,
  workspaceStateVersion: 1,
  syncStateVersion: 1,
} as const;

export interface Migration {
  readonly version: number;
  readonly description: string;
  migrate(dataDir: string): void | Promise<void>;
}

function ensureDirs(dataDir: string, subdirs: readonly string[]): void {
  for (const subdir of subdirs) {
    fs.mkdirSync(path.join(dataDir, subdir), { recursive: true });
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "Create versioned data directories and database placeholder",
    migrate(dataDir: string): void {
      ensureDirs(dataDir, APP_DATA_SUBDIRS);
      const databasesDir = path.join(dataDir, "databases");
      fs.mkdirSync(databasesDir, { recursive: true });
      const placeholder = path.join(databasesDir, ".placeholder");
      if (!fs.existsSync(placeholder)) {
        fs.writeFileSync(
          placeholder,
          "SQLite database files are created here at runtime by the storage layer.\n",
          "utf8",
        );
      }
    },
  },
];

export type MigrationErrorOptions = {
  readonly message: string;
  readonly dataDir: string;
  readonly migrationVersion?: number;
  readonly backupPath?: string;
};

export class MigrationError extends Error {
  readonly code = "MIGRATION_FAILED" as const;
  readonly dataDir: string;
  readonly migrationVersion?: number;
  readonly backupPath?: string;

  constructor(options: MigrationErrorOptions) {
    super(options.message);
    this.name = "MigrationError";
    this.dataDir = options.dataDir;
    this.migrationVersion = options.migrationVersion;
    this.backupPath = options.backupPath;
  }
}

export interface ResolveAppDataDirOptions {
  readonly appName?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Best-effort read of Electron's userData path. Returns undefined when
 * Electron is unavailable or the app is not ready yet (tests, scripts,
 * early boot). The static import above resolves to the packaged runtime in
 * production and to undefined bindings under plain Node, so the call itself
 * is guarded with try/catch.
 */
function readElectronUserDataDir(): string | undefined {
  try {
    const getPath = app?.getPath;
    if (typeof getPath === "function") {
      const candidate: unknown = getPath.call(app, "userData");
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate;
      }
    }
  } catch {
    // Fall through to the tmpdir fallback below (tests, scripts, early boot).
  }
  return undefined;
}

/**
 * Resolves the per-user data directory. Prefers an explicit
 * AI_DESKTOP_DATA_DIR override, then Electron's userData path (already
 * app-scoped), then a tmpdir fallback used by tests and scripts.
 */
export function resolveAppDataDir(options?: ResolveAppDataDirOptions): string {
  const env = options?.env ?? process.env;
  const override = env.AI_DESKTOP_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  const fromElectron = readElectronUserDataDir();
  if (fromElectron) {
    return fromElectron;
  }
  const appName = options?.appName?.trim() || getAppDataDirName();
  return path.join(os.tmpdir(), appName);
}

export function getVersionsFilePath(dataDir: string): string {
  return path.join(dataDir, "versions.json");
}

/** Reads versions.json, or undefined when it does not exist yet. */
export function readVersionsFile(dataDir: string): VersionsFile | undefined {
  const file = getVersionsFilePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    throw new MigrationError({
      message: "Cannot read the versions file; refusing to migrate.",
      dataDir,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MigrationError({
      message: "Existing versions file is not valid JSON; refusing to migrate.",
      dataDir,
    });
  }
  const result = VersionsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new MigrationError({
      message: "Existing versions file failed validation; refusing to migrate.",
      dataDir,
    });
  }
  return result.data;
}

/** Atomic write of versions.json via temp file plus rename. */
export function writeVersionsFile(dataDir: string, versions: VersionsFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = getVersionsFilePath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(versions, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Copies the current versions.json (when present) into the backups folder
 * and returns the backup path. Never throws: backup is best-effort and the
 * original file is always left untouched.
 */
function preserveVersionsBackup(dataDir: string): string | undefined {
  try {
    const file = getVersionsFilePath(dataDir);
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const backupsDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const backupPath = path.join(backupsDir, `versions.backup.${Date.now()}.json`);
    fs.copyFileSync(file, backupPath);
    return backupPath;
  } catch {
    return undefined;
  }
}

/**
 * Applies pending migrations in ascending version order, skipping versions
 * at or below baseline.schemaVersion (idempotent re-runs are no-ops).
 * Writes nothing itself: callers persist the returned record. On failure the
 * prior record is left untouched and a backup copy is preserved.
 */
export async function applyMigrations(
  dataDir: string,
  baseline: VersionsFile,
  migrations: readonly Migration[],
): Promise<VersionsFile> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  let current = baseline;
  for (const migration of ordered) {
    if (migration.version <= current.schemaVersion) {
      continue;
    }
    try {
      const outcome = migration.migrate(dataDir);
      if (outcome instanceof Promise) {
        await outcome;
      }
    } catch {
      const backupPath = preserveVersionsBackup(dataDir);
      throw new MigrationError({
        message:
          `Migration v${migration.version} failed; the data directory was left untouched.` +
          (backupPath ? ` Backup preserved at ${backupPath}.` : ""),
        dataDir,
        migrationVersion: migration.version,
        backupPath,
      });
    }
    current = { ...current, schemaVersion: migration.version };
  }
  return current;
}

/**
 * Brings a data directory to the current generation: creates it, reads (or
 * defaults) versions.json, applies pending migrations, then persists the
 * record. Re-running with the same app version performs no writes.
 */
export async function runMigrations(dataDir: string, appVersion: string): Promise<VersionsFile> {
  const normalizedVersion = appVersion.trim().length > 0 ? appVersion.trim().slice(0, 64) : "0.0.0";
  fs.mkdirSync(dataDir, { recursive: true });
  const prior = readVersionsFile(dataDir);
  // Fresh directories start below every migration version so the full chain
  // applies; existing records resume from their recorded schemaVersion.
  const baseline: VersionsFile = prior ?? {
    appVersion: normalizedVersion,
    schemaVersion: 0,
    configVersion: CURRENT_VERSIONS.configVersion,
    workspaceStateVersion: CURRENT_VERSIONS.workspaceStateVersion,
    syncStateVersion: CURRENT_VERSIONS.syncStateVersion,
  };
  const migrated = await applyMigrations(dataDir, baseline, MIGRATIONS);
  const finalVersions: VersionsFile = { ...migrated, appVersion: normalizedVersion };
  if (prior === undefined || JSON.stringify(finalVersions) !== JSON.stringify(prior)) {
    writeVersionsFile(dataDir, finalVersions);
  }
  return finalVersions;
}
