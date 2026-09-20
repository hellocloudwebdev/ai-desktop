// PR47: apps/desktop — Secure Update Service
//
// Fail-closed updater orchestration over an injected autoUpdater adapter.
// No direct Electron imports (the adapter is injected) — safe for unit tests.
//
// Guarantees:
//   - Feed URLs are validated HTTPS + host-allowlisted on every check.
//   - Candidates must be valid semver strictly newer than currentVersion,
//     on the expected channel, with an HTTPS artifact allowlisted by
//     extension, and a well-formed sha256 when one is advertised.
//   - Downloads are checksum-verified when a sha256 is known.
//   - quitAndInstall is gated on the verified ready/downloaded state.
//   - Errors crossing the boundary are redacted (no secrets, single line).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { redactSecrets } from "@ai-desktop/shared";
import {
  compareSemver,
  SemverSchema,
  UpdateChannelSchema,
  type UpdateChannel,
  type UpdateState,
} from "./update-types.js";
import { DEFAULT_UPDATE_HOSTS, validateFeedUrl } from "./update-feed.js";

// ---------------------------------------------------------------------------
// Security invariants (PR47)
// ---------------------------------------------------------------------------

export const UPDATE_SECURITY_INVARIANTS = [
  "permission-manager-enabled",
  "trust-config-immutable",
  "no-renderer-injection",
  "no-silent-plugin-install",
  "no-silent-task-install",
] as const;

const FORBIDDEN_METADATA_KEYS = [
  "disablePermissions",
  "trustOverride",
  "scriptUrls",
  "evalPayload",
  "silentPluginInstall",
  "silentTaskInstall",
] as const;

/**
 * Throws when update metadata carries keys that would weaken the desktop
 * trust model (permission bypasses, script injection, silent installs).
 * Scans nested objects/arrays; cycle-safe.
 */
export function enforceUpdateSecurity(metadata: unknown): void {
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if ((FORBIDDEN_METADATA_KEYS as readonly string[]).includes(key)) {
        throw new Error(`Update metadata violates security invariants: "${key}" is forbidden`);
      }
      visit(record[key]);
    }
  };
  visit(metadata);
}

// ---------------------------------------------------------------------------
// Adapter + dependency types
// ---------------------------------------------------------------------------

/** Raw candidate reported by the underlying updater backend. */
export interface UpdateCheckResult {
  readonly version: string;
  readonly artifactUrl: string;
  readonly sha256?: string;
  readonly channel?: string;
}

export interface UpdateAutoUpdaterAdapter {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<string>;
  quitAndInstall(): void;
}

export interface SecureUpdateServiceDeps {
  readonly feedUrl: string;
  readonly channel: UpdateChannel;
  readonly currentVersion: string;
  readonly allowedHosts?: readonly string[];
  readonly autoUpdater: UpdateAutoUpdaterAdapter;
  emit(event: string, payload?: unknown): void;
  hashFile?(filePath: string, expectedSha256: string): Promise<boolean>;
}

export interface ValidatedUpdateCandidate {
  readonly version: string;
  readonly artifactUrl: string;
  readonly sha256?: string;
}

export interface UpdateSnapshot {
  readonly state: UpdateState;
  readonly error: string | null;
  readonly recoverable: boolean;
  readonly version: string | null;
}

/** Artifact extensions the updater is allowed to fetch/execute. */
export const UPDATE_ALLOWED_ARTIFACT_EXTENSIONS = [
  ".exe",
  ".dmg",
  ".zip",
  ".appimage",
  ".nupkg",
  ".blockmap",
] as const;

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Default streaming sha256 verifier (node:crypto). Returns false on any
 * read error so callers fail closed.
 */
export async function hashFileSha256(filePath: string, expectedSha256: string): Promise<boolean> {
  const expected = expectedSha256.trim().toLowerCase();
  try {
    const digest: string = await new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      stream.on("error", (err: Error) => {
        reject(err);
      });
      stream.on("end", () => {
        resolve(hash.digest("hex"));
      });
    });
    return digest.toLowerCase() === expected;
  } catch {
    return false;
  }
}

function artifactExtensionOk(artifactUrl: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(artifactUrl).pathname.toLowerCase();
  } catch {
    return false;
  }
  return UPDATE_ALLOWED_ARTIFACT_EXTENSIONS.some((ext) => pathname.endsWith(ext));
}

/**
 * Fail-closed candidate validation. Throws a safe (secret-free) error when
 * the candidate is stale, off-channel, or malformed.
 */
export function validateUpdateCandidate(
  candidate: UpdateCheckResult,
  opts: { channel: UpdateChannel; currentVersion: string },
): ValidatedUpdateCandidate {
  UpdateChannelSchema.parse(opts.channel);
  let version = "";
  try {
    version = SemverSchema.parse(candidate.version);
  } catch {
    throw new Error("Invalid update: version must be valid semver");
  }
  let newer = false;
  try {
    newer = compareSemver(version, opts.currentVersion) === 1;
  } catch {
    throw new Error("Invalid update: current version must be valid semver");
  }
  if (!newer) {
    throw new Error("Invalid update: candidate is not newer than the current version");
  }
  if (candidate.channel !== undefined && candidate.channel !== opts.channel) {
    throw new Error("Invalid update: channel mismatch");
  }
  let artifact: URL;
  try {
    artifact = new URL(candidate.artifactUrl);
  } catch {
    throw new Error("Invalid update: artifact URL is not parseable");
  }
  if (artifact.protocol !== "https:") {
    throw new Error("Invalid update: artifact URL must use https");
  }
  if (!artifactExtensionOk(candidate.artifactUrl)) {
    throw new Error("Invalid update: artifact extension is not allowlisted");
  }
  if (candidate.sha256 !== undefined) {
    if (typeof candidate.sha256 !== "string" || !SHA256_PATTERN.test(candidate.sha256.trim())) {
      throw new Error("Invalid update: sha256 must be 64 hex characters");
    }
    return {
      version,
      artifactUrl: candidate.artifactUrl,
      sha256: candidate.sha256.trim().toLowerCase(),
    };
  }
  return { version, artifactUrl: candidate.artifactUrl };
}

/** Single-line, secret-free, length-capped error for the update boundary. */
function toSafeUpdateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactSecrets(raw).split("\n")[0]?.trim() ?? "";
  const capped = redacted.length > 500 ? redacted.slice(0, 500) : redacted;
  return capped.length > 0 ? capped : "update failed";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SecureUpdateService {
  private status: UpdateState = "idle";
  private lastError: string | null = null;
  private pending: ValidatedUpdateCandidate | null = null;
  private downloadedPath: string | null = null;
  private lastVersion: string | null = null;

  constructor(private readonly deps: SecureUpdateServiceDeps) {
    UpdateChannelSchema.parse(deps.channel);
    SemverSchema.parse(deps.currentVersion);
  }

  getState(): UpdateState {
    return this.status;
  }

  getSnapshot(): UpdateSnapshot {
    return {
      state: this.status,
      error: this.lastError,
      recoverable: this.status === "failed",
      version: this.lastVersion,
    };
  }

  private broadcast(): void {
    try {
      this.deps.emit("updates:state", this.getSnapshot());
    } catch {
      // State broadcast is best-effort; never breaks the update flow.
    }
  }

  private fail(err: unknown): UpdateState {
    this.lastError = toSafeUpdateError(err);
    this.status = "failed";
    this.broadcast();
    return this.status;
  }

  async checkForUpdates(): Promise<UpdateState> {
    this.status = "checking";
    this.lastError = null;
    this.broadcast();
    try {
      validateFeedUrl(this.deps.feedUrl, this.deps.allowedHosts ?? DEFAULT_UPDATE_HOSTS);
      const found = await this.deps.autoUpdater.checkForUpdates();
      if (found === null) {
        this.pending = null;
        this.lastVersion = null;
        this.status = "up-to-date";
        this.broadcast();
        return this.status;
      }
      enforceUpdateSecurity(found);
      const candidate = validateUpdateCandidate(found, {
        channel: this.deps.channel,
        currentVersion: this.deps.currentVersion,
      });
      this.pending = candidate;
      this.downloadedPath = null;
      this.lastVersion = candidate.version;
      this.status = "available";
      this.broadcast();
      return this.status;
    } catch (err) {
      return this.fail(err);
    }
  }

  async downloadUpdate(): Promise<string> {
    const pending = this.pending;
    if (this.status !== "available" || pending === null) {
      throw new Error("No update available to download");
    }
    this.status = "downloading";
    this.lastError = null;
    this.broadcast();
    try {
      const candidate = validateUpdateCandidate(pending, {
        channel: this.deps.channel,
        currentVersion: this.deps.currentVersion,
      });
      const filePath = await this.deps.autoUpdater.downloadUpdate();
      if (typeof filePath !== "string" || filePath.length === 0) {
        throw new Error("Update download did not produce a file");
      }
      if (candidate.sha256 !== undefined) {
        this.status = "verifying";
        this.broadcast();
        const verify = this.deps.hashFile ?? hashFileSha256;
        const ok = await verify(filePath, candidate.sha256);
        if (!ok) {
          this.fail(new Error("Update checksum mismatch"));
          throw new Error("Update checksum mismatch");
        }
      }
      this.downloadedPath = filePath;
      this.status = "ready";
      this.broadcast();
      return filePath;
    } catch (err) {
      if ((this.status as UpdateState) !== "failed") {
        this.fail(err);
      }
      throw new Error(this.lastError ?? "update failed");
    }
  }

  async quitAndInstall(): Promise<void> {
    if ((this.status !== "ready" && this.status !== "downloaded") || this.downloadedPath === null) {
      throw new Error("Update is not ready to install");
    }
    this.status = "installing";
    this.broadcast();
    try {
      this.deps.autoUpdater.quitAndInstall();
      this.status = "updated";
      this.broadcast();
    } catch (err) {
      this.fail(err);
      throw new Error(this.lastError ?? "update failed");
    }
  }
}
