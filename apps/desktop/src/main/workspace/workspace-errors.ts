// PR41: apps/desktop — Workspace Error Primitives
//
// Typed workspace errors shared by the file/search/diagnostics services.
// Every service maps backend, path-policy, and filesystem failures into
// WorkspaceError so IPC handlers and tests see stable codes instead of raw
// exceptions or absolute main-side paths.

import { BaseError } from "@ai-desktop/shared";
import { PathPolicyError } from "../agent/filesystem/path-policy.js";

export type WorkspaceErrorCode =
  | "NO_WORKSPACE"
  | "NOT_FOUND"
  | "OUTSIDE_WORKSPACE"
  | "SYMLINK_ESCAPE"
  | "TOO_LARGE"
  | "IS_DIRECTORY"
  | "INVALID"
  | "BINARY_FILE"
  | "EXTERNAL_MODIFIED";

export class WorkspaceError extends BaseError {
  constructor(
    readonly workspaceCode: WorkspaceErrorCode,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(workspaceCode, message, options);
    this.name = "WorkspaceError";
  }
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return value instanceof WorkspaceError;
}

export interface CanonicalWorkspaceError {
  readonly code: string;
  readonly message: string;
}

/**
 * Converts any thrown value into a serializable code + message pair without
 * leaking absolute main-side paths. Unknown failures collapse to INVALID
 * with a fixed message rather than a raw node error string.
 */
export function toCanonicalWorkspaceError(err: unknown): CanonicalWorkspaceError {
  if (err instanceof WorkspaceError) {
    return { code: err.workspaceCode, message: err.message };
  }
  if (err instanceof PathPolicyError) {
    const code = err.code === "INVALID_PATH" ? "INVALID" : err.code;
    return { code, message: sanitizePolicyMessage(err.message) };
  }
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") {
    return { code: "NOT_FOUND", message: "Path does not exist" };
  }
  if (code === "EISDIR") {
    return { code: "IS_DIRECTORY", message: "Target is a directory" };
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return { code: "INVALID", message: "Operation not permitted" };
  }
  if (code === "ENAMETOOLONG" || code === "EINVAL" || code === "ENOTDIR" || code === "EEXIST") {
    return { code: "INVALID", message: "Invalid path or target" };
  }
  return { code: "INVALID", message: "Workspace operation failed" };
}

/**
 * PathPolicyError messages echo the workspace root or absolute paths; keep
 * only the user-supplied portion for renderer-facing surfaces.
 */
function sanitizePolicyMessage(message: string): string {
  const marker = message.indexOf('"');
  if (marker === -1) return "Invalid workspace path";
  return message.slice(0, marker).trim() || "Invalid workspace path";
}
