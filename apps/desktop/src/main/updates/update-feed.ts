// PR47: apps/desktop — Secure Update Feed
//
// Feed URL construction and fail-closed manifest validation for the updater.
// HTTPS-only; host allowlist enforced; beta/nightly feeds are rejected unless
// the caller explicitly opts into previews. No Electron imports.

import {
  UpdateArchSchema,
  UpdateChannelSchema,
  UpdateMetadataSchema,
  UpdatePlatformSchema,
  type UpdateArch,
  type UpdateChannel,
  type UpdateMetadata,
  type UpdatePlatform,
} from "./update-types.js";

// ---------------------------------------------------------------------------
// Allowed hosts
// ---------------------------------------------------------------------------

export const DEFAULT_UPDATE_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "releases.githubusercontent.com",
] as const;

export type UpdateAllowedHost = (typeof DEFAULT_UPDATE_HOSTS)[number];

// ---------------------------------------------------------------------------
// Feed URL construction
// ---------------------------------------------------------------------------

export interface BuildFeedUrlOptions {
  readonly repo: string;
  readonly channel: UpdateChannel;
  readonly platform: UpdatePlatform;
  readonly arch: UpdateArch;
  /** Opt-in to beta/nightly feeds. Defaults to false (stable only). */
  readonly allowPreview?: boolean;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function validateRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\/+$/, "");
  if (!REPO_PATTERN.test(trimmed)) {
    throw new Error(`Invalid update repo "${repo}": expected "<owner>/<name>"`);
  }
  return trimmed;
}

/**
 * Builds the HTTPS manifest URL for a release feed.
 *
 * Stable feeds resolve under `https://github.com/<repo>/releases/...`.
 * Beta/nightly channels throw unless `allowPreview` is true (fail-closed:
 * preview builds never leak into stable update checks).
 */
export function buildFeedUrl(opts: BuildFeedUrlOptions): string {
  const repo = validateRepo(opts.repo);
  const channel = UpdateChannelSchema.parse(opts.channel);
  const platform = UpdatePlatformSchema.parse(opts.platform);
  const arch = UpdateArchSchema.parse(opts.arch);
  const file = `update-${platform}-${arch}.json`;

  if (channel === "stable") {
    return `https://github.com/${repo}/releases/latest/download/${file}`;
  }
  if (opts.allowPreview !== true) {
    throw new Error("only stable supported: pass allowPreview to build beta/nightly feed URLs");
  }
  if (channel === "beta") {
    return `https://github.com/${repo}/releases/download/beta/${file}`;
  }
  return `https://github.com/${repo}/releases/download/nightly/${file}`;
}

// ---------------------------------------------------------------------------
// Feed URL validation (HTTPS-only, host allowlist, fail-closed)
// ---------------------------------------------------------------------------

/**
 * Validates a feed URL. Throws when the URL is not HTTPS, carries embedded
 * credentials, or points at a host outside the allowlist.
 */
export function validateFeedUrl(
  url: string,
  allowedHosts: readonly string[] = DEFAULT_UPDATE_HOSTS,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid update feed URL: not a parseable URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid update feed URL: only https is allowed (got "${parsed.protocol}")`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Invalid update feed URL: embedded credentials are not allowed");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    throw new Error(`Invalid update feed URL: host "${parsed.hostname}" is not allowlisted`);
  }
}

// ---------------------------------------------------------------------------
// Manifest parsing (zod, fail-closed)
// ---------------------------------------------------------------------------

function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
}

/**
 * Parses and validates an update manifest. Rejects malformed metadata,
 * non-HTTPS artifacts, missing checksums, and channel mismatches.
 */
export function parseUpdateManifest(
  json: unknown,
  expectedChannel?: UpdateChannel,
): UpdateMetadata {
  let candidate: unknown = json;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error("Invalid update manifest: not valid JSON");
    }
  }
  const parsed = UpdateMetadataSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Invalid update manifest: ${formatIssues(parsed.error.issues)}`);
  }
  if (expectedChannel !== undefined && parsed.data.channel !== expectedChannel) {
    throw new Error(
      `Invalid update manifest: channel mismatch (expected "${expectedChannel}", got "${parsed.data.channel}")`,
    );
  }
  return parsed.data;
}
