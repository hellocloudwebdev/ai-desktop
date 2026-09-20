// PR47: apps/desktop — Secure Update Types
//
// Zod-validated update metadata, channel/state enums, and semver helpers.
// Fail-closed: bad versions, non-HTTPS artifacts, and malformed checksums
// are rejected at the schema boundary. No Electron imports — safe for tests.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const UPDATE_CHANNELS = ["stable", "beta", "nightly"] as const;

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const UpdateChannelSchema = z.enum(UPDATE_CHANNELS);

// ---------------------------------------------------------------------------
// Platforms / architectures (bounded — fail closed on unknown values)
// ---------------------------------------------------------------------------

export const UPDATE_PLATFORMS = ["win32", "darwin", "linux"] as const;

export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

export const UpdatePlatformSchema = z.enum(UPDATE_PLATFORMS);

export const UPDATE_ARCHES = ["x64", "arm64"] as const;

export type UpdateArch = (typeof UPDATE_ARCHES)[number];

export const UpdateArchSchema = z.enum(UPDATE_ARCHES);

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const SemverSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SEMVER_PATTERN, { message: "Version must be valid semver (MAJOR.MINOR.PATCH)" });

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isIsoDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Update metadata (zod-validated, fail-closed)
// ---------------------------------------------------------------------------

export const UpdateMetadataSchema = z.object({
  version: SemverSchema,
  channel: UpdateChannelSchema,
  platform: UpdatePlatformSchema,
  arch: UpdateArchSchema,
  artifact: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .url()
    .refine(isHttpsUrl, { message: "Artifact URL must use https" }),
  sha256: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, { message: "sha256 must be 64 hex characters" })
    .transform((value) => value.toLowerCase()),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  releaseDate: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isIsoDateString, { message: "releaseDate must be an ISO date string" }),
  minSupportedVersion: SemverSchema.optional(),
});

export type UpdateMetadata = z.infer<typeof UpdateMetadataSchema>;

// ---------------------------------------------------------------------------
// Lifecycle states (PR47 lifecycle)
// ---------------------------------------------------------------------------

export const UPDATE_STATES = [
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "verifying",
  "ready",
  "installing",
  "updated",
  "up-to-date",
  "failed",
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

export const UpdateStateSchema = z.enum(UPDATE_STATES);

// ---------------------------------------------------------------------------
// Semver comparison
// ---------------------------------------------------------------------------

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
}

function parseSemverStrict(version: string): ParsedSemver {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (match === null) {
    throw new Error(`Invalid semver: ${version}`);
  }
  const prerelease: Array<string | number> =
    match[4] === undefined
      ? []
      : match[4].split(".").map((ident) => (/^[0-9]+$/.test(ident) ? Number(ident) : ident));
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(
  a: ReadonlyArray<string | number>,
  b: ReadonlyArray<string | number>,
): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  // A version without prerelease has higher precedence than one with it.
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] as string | number;
    const right = b[i] as string | number;
    if (typeof left === "number" && typeof right === "number") {
      if (left !== right) {
        return left < right ? -1 : 1;
      }
    } else if (typeof left === "number") {
      return -1;
    } else if (typeof right === "number") {
      return 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * Compares two semver strings. Build metadata is ignored per the semver
 * spec. Throws on invalid input (fail-closed).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemverStrict(a);
  const pb = parseSemverStrict(b);
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Returns true when `candidate` is strictly newer than `current`.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) === 1;
}

/**
 * Returns true when `current` satisfies an update's minimum supported
 * version. No constraint means any current version may upgrade.
 */
export function isSupportedUpgrade(current: string, minSupported?: string): boolean {
  if (minSupported === undefined) {
    return true;
  }
  return compareSemver(current, minSupported) >= 0;
}
