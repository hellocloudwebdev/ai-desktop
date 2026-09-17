// PR42: apps/desktop — Git Error Primitives
//
// Typed Git errors for repository inspection, staging, diffing, and commits.
// Ensures stable error codes for IPC handlers, tool executors, and tests without
// leaking raw paths, stack traces, or credentials.

import { BaseError } from "@ai-desktop/shared";
import { PathPolicyError } from "../agent/filesystem/path-policy.js";

export type GitServiceErrorCode =
  | "NO_WORKSPACE"
  | "NOT_A_REPO"
  | "PATH_OUTSIDE_WORKSPACE"
  | "SYMLINK_ESCAPE"
  | "INVALID_PATH"
  | "NOTHING_STAGED"
  | "NOTHING_TO_COMMIT"
  | "COMMIT_FAILED"
  | "COMMAND_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "PERMISSION_DENIED"
  | "EMPTY_COMMIT_MESSAGE"
  | "DISCARD_FAILED";

export class GitServiceError extends BaseError {
  constructor(
    readonly gitCode: GitServiceErrorCode,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(gitCode, message, options);
    this.name = "GitServiceError";
  }
}

export function isGitServiceError(value: unknown): value is GitServiceError {
  return value instanceof GitServiceError;
}

export interface CanonicalGitError {
  readonly code: string;
  readonly message: string;
}

/**
 * Converts any thrown Git error into a serializable code + message pair
 * without leaking absolute filesystem paths or secret environment variables.
 */
export function toCanonicalGitError(err: unknown): CanonicalGitError {
  if (err instanceof GitServiceError) {
    return { code: err.gitCode, message: err.message };
  }

  if (err instanceof PathPolicyError) {
    if (err.code === "OUTSIDE_WORKSPACE") {
      return { code: "PATH_OUTSIDE_WORKSPACE", message: "Path is outside workspace root" };
    }
    if (err.code === "SYMLINK_ESCAPE") {
      return { code: "SYMLINK_ESCAPE", message: "Path escapes workspace root via symlink" };
    }
    return { code: "INVALID_PATH", message: err.message };
  }

  if (err instanceof Error) {
    const msg = err.message;
    if (/timed?\s*out/i.test(msg)) {
      return { code: "TIMEOUT", message: "Git command timed out" };
    }
    if (/abort|cancel/i.test(msg)) {
      return { code: "CANCELLED", message: "Git operation was cancelled" };
    }
    if (/not a git repository/i.test(msg)) {
      return { code: "NOT_A_REPO", message: "Workspace is not a Git repository" };
    }
    return { code: "COMMAND_FAILED", message: msg };
  }

  return { code: "COMMAND_FAILED", message: String(err) };
}
