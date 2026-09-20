// apps/desktop — First-run initialization for packaged releases.
//
// Creates the local directory skeleton and records the versions file on
// first launch. Local-only by construction: this module performs filesystem
// writes and nothing else — no network calls, no cloud accounts, no outbound
// transfers, no plugin installation or enablement.

import fs from "node:fs";
import path from "node:path";
import { APP_DATA_SUBDIRS, readVersionsFile, runMigrations } from "./app-data.js";

export const FIRST_RUN_SUBDIRS = APP_DATA_SUBDIRS;

export interface FirstRunOptions {
  readonly appVersion: string;
}

export interface FirstRunResult {
  readonly firstRun: boolean;
  readonly dataDir: string;
}

/**
 * Ensures the data directory exists for this app version. Returns
 * firstRun: true when versions.json did not exist before this call (genuine
 * first launch), false on subsequent launches. Never throws for the
 * already-initialized case beyond propagating migration failures.
 */
export async function initializeFirstRun(
  dataDir: string,
  options: FirstRunOptions,
): Promise<FirstRunResult> {
  const normalizedVersion =
    options.appVersion.trim().length > 0 ? options.appVersion.trim().slice(0, 64) : "0.0.0";
  fs.mkdirSync(dataDir, { recursive: true });
  const alreadyInitialized = readVersionsFile(dataDir) !== undefined;
  await runMigrations(dataDir, normalizedVersion);
  for (const subdir of FIRST_RUN_SUBDIRS) {
    fs.mkdirSync(path.join(dataDir, subdir), { recursive: true });
  }
  return { firstRun: !alreadyInitialized, dataDir };
}
