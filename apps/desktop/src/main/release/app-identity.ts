// apps/desktop — Release app identity.
//
// Single source of truth for the packaged application identity: bundle ids,
// protocol scheme, executable name, and release channel. This module has no
// runtime dependencies so it is safe to import from tests, scripts, and the
// main process without side effects.

export const APP_IDENTITY = {
  appId: "com.aidesktop.app",
  productName: "AI Desktop",
  executableName: "aidesktop",
  bundleId: "com.aidesktop.app",
  protocol: "aidesktop",
  channel: "stable",
} as const;

export type AppIdentity = typeof APP_IDENTITY;

/**
 * Directory name used for the per-user application data folder.
 * Stable across releases: renaming it would orphan existing user data.
 */
export function getAppDataDirName(): string {
  return APP_IDENTITY.productName;
}
