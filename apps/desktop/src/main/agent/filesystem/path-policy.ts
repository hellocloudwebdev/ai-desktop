// PR30.4: apps/desktop — Workspace Path Policy
//
// Invariants:
//   1. Every path is normalized, resolved, and compared against the workspace
//      root with realpath containment (symlink-aware), never a string prefix.
//   2. Traversal (..), absolute outside paths, and symlink escapes are rejected.
//   3. Pure policy: no filesystem writes here, only resolution + containment.

import fs from "node:fs";
import path from "node:path";

export class PathPolicyError extends Error {
  constructor(
    message: string,
    readonly code: "OUTSIDE_WORKSPACE" | "SYMLINK_ESCAPE" | "NOT_FOUND" | "INVALID_PATH",
  ) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export interface ResolvedWorkspacePath {
  /** Absolute real path of the workspace root (symlinks resolved). */
  readonly workspaceRootReal: string;
  /** Absolute real path of the resolved target. */
  readonly targetReal: string;
  /** Target relative to the workspace root using posix-style separators. */
  readonly relative: string;
}

/**
 * Resolves a user/model-supplied path against the workspace root and proves
 * containment. Throws PathPolicyError on any violation.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): ResolvedWorkspacePath {
  if (!requestedPath || typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
    throw new PathPolicyError("Path must be a non-empty string", "INVALID_PATH");
  }
  if (requestedPath.includes("\0")) {
    throw new PathPolicyError("Path contains a NUL byte", "INVALID_PATH");
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(workspaceRoot));
  } catch {
    throw new PathPolicyError(`Workspace root does not exist: "${workspaceRoot}"`, "NOT_FOUND");
  }

  // Resolve the request against the root (absolute requests must still land inside).
  const joined = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.join(rootReal, requestedPath);

  let targetReal: string;
  try {
    // realpath resolves symlinks on every existing segment. For a target that
    // does not exist yet (write path), resolve the nearest existing ancestor
    // and re-anchor the remainder — the remainder cannot contain symlinks
    // because none of its segments exist.
    targetReal = resolveWithMissingTail(joined);
  } catch (err: unknown) {
    if (err instanceof PathPolicyError) throw err;
    throw new PathPolicyError(
      `Cannot resolve path "${requestedPath}": ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_PATH",
    );
  }

  if (!isWithin(targetReal, rootReal)) {
    throw new PathPolicyError(`Path "${requestedPath}" escapes the workspace`, "OUTSIDE_WORKSPACE");
  }

  const relative = path.relative(rootReal, targetReal).split(path.sep).join("/");
  return { workspaceRootReal: rootReal, targetReal, relative: relative === "" ? "." : relative };
}

function resolveWithMissingTail(joined: string): string {
  try {
    return fs.realpathSync(joined);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") throw err;
    // Walk up to the nearest existing ancestor, then re-anchor.
    const missing: string[] = [];
    let cursor = joined;
    for (;;) {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new PathPolicyError(`No existing ancestor for "${joined}"`, "NOT_FOUND");
      }
      missing.unshift(path.basename(cursor));
      try {
        const ancestorReal = fs.realpathSync(parent);
        // A symlink in the missing tail cannot exist (segments don't exist),
        // but the ancestor itself is now fully resolved.
        return path.join(ancestorReal, ...missing);
      } catch (inner: unknown) {
        if ((inner as { code?: string }).code !== "ENOENT") throw inner;
        cursor = parent;
      }
    }
  }
}

/**
 * Realpath containment: identical paths count as inside; otherwise the target
 * must start with root + separator. Case sensitivity follows the platform.
 */
function isWithin(targetReal: string, rootReal: string): boolean {
  if (targetReal === rootReal) return true;
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (process.platform === "win32") {
    return targetReal.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return targetReal.startsWith(prefix);
}

/**
 * Rejects symlink escapes for an existing target: the fully resolved real
 * path must stay inside the resolved workspace root.
 */
export function assertNoSymlinkEscape(workspaceRoot: string, targetReal: string): void {
  const rootReal = fs.realpathSync(path.resolve(workspaceRoot));
  if (!isWithin(targetReal, rootReal)) {
    throw new PathPolicyError(
      `Symlink target escapes the workspace: "${targetReal}"`,
      "SYMLINK_ESCAPE",
    );
  }
}
