// PR30.5/30.6: apps/desktop — Workspace Filesystem Tool Backend
//
// Invariants:
//   1. Every operation resolves through resolveWorkspacePath first; no operation
//      touches a path outside the workspace root.
//   2. Bounded operations: read bytes, write bytes, search results, search bytes,
//      returned lines. Oversized operations return structured tool errors, never
//      unbounded buffers.
//   3. Deterministic recursive search over the real filesystem (no shell-out to
//      grep); generated/dependency directories excluded and documented.
//   4. No permission logic here — the executor checks PermissionManager first.

import fs from "node:fs";
import path from "node:path";
import { PathPolicyError, resolveWorkspacePath } from "./path-policy.js";

export const MAX_READ_BYTES = 64 * 1024; // 64 KB per read
export const MAX_WRITE_BYTES = 64 * 1024; // 64 KB per write
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_BYTES = 64 * 1024;
export const MAX_RETURNED_LINES = 500;

/** Directories never descended into during workspace search. */
export const SEARCH_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

export interface FilesystemError {
  readonly error: string;
  readonly code: string;
}

export interface ListResult {
  readonly path: string;
  readonly entries: Array<{ name: string; kind: "file" | "directory" }>;
}

export interface ReadResult {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly totalLines: number;
}

export interface WriteResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
}

export interface SearchResult {
  readonly matches: Array<{ path: string; line?: number; text?: string }>;
  readonly truncated: boolean;
}

function toError(err: unknown, fallbackCode: string): FilesystemError {
  if (err instanceof PathPolicyError) {
    return { error: err.message, code: err.code };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? fallbackCode;
  return { error: message, code };
}

export function listDirectory(
  workspaceRoot: string,
  requestedPath: string,
): ListResult | FilesystemError {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, requestedPath);
    const entries = fs.readdirSync(resolved.targetReal, { withFileTypes: true }).map((e) => ({
      name: e.name,
      kind: (e.isDirectory() ? "directory" : "file") as "file" | "directory",
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: resolved.relative, entries };
  } catch (err: unknown) {
    return toError(err, "LIST_FAILED");
  }
}

export function readFile(
  workspaceRoot: string,
  requestedPath: string,
  startLine?: number,
  endLine?: number,
): ReadResult | FilesystemError {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, requestedPath);
    const stat = fs.statSync(resolved.targetReal);
    if (!stat.isFile()) {
      return { error: `Not a file: "${requestedPath}"`, code: "NOT_A_FILE" };
    }
    if (stat.size > MAX_READ_BYTES * 4) {
      return {
        error: `File exceeds readable size ceiling (${stat.size} bytes)`,
        code: "FILE_TOO_LARGE",
      };
    }
    const raw = fs.readFileSync(resolved.targetReal, "utf8");
    const lines = raw.split("\n");
    const totalLines = lines.length;
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(totalLines, endLine ?? totalLines);
    if (from > to) {
      return { error: `Invalid line range ${from}-${to} of ${totalLines}`, code: "INVALID_RANGE" };
    }
    let selected = lines.slice(from - 1, to);
    // Enforce line-count and byte ceilings on the returned window.
    let truncated = to < totalLines || from > 1;
    if (selected.length > MAX_RETURNED_LINES) {
      selected = selected.slice(0, MAX_RETURNED_LINES);
      truncated = true;
    }
    let content = selected.join("\n");
    if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
      const buf = Buffer.from(content, "utf8").subarray(0, MAX_READ_BYTES);
      content = buf.toString("utf8");
      truncated = true;
    }
    return { path: resolved.relative, content, truncated, totalLines };
  } catch (err: unknown) {
    return toError(err, "READ_FAILED");
  }
}

export function writeFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
): WriteResult | FilesystemError {
  try {
    const resolved = resolveWorkspacePath(workspaceRoot, requestedPath);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WRITE_BYTES) {
      return {
        error: `Write exceeds ${MAX_WRITE_BYTES} bytes (${bytes} bytes)`,
        code: "WRITE_TOO_LARGE",
      };
    }
    const existed = fs.existsSync(resolved.targetReal);
    if (existed && fs.statSync(resolved.targetReal).isDirectory()) {
      return { error: `Cannot overwrite directory: "${requestedPath}"`, code: "IS_DIRECTORY" };
    }
    fs.mkdirSync(path.dirname(resolved.targetReal), { recursive: true });
    fs.writeFileSync(resolved.targetReal, content, "utf8");
    return { path: resolved.relative, bytesWritten: bytes, created: !existed };
  } catch (err: unknown) {
    return toError(err, "WRITE_FAILED");
  }
}

export function searchWorkspace(
  workspaceRoot: string,
  requestedPath: string,
  query: string,
): SearchResult | FilesystemError {
  try {
    if (!query || query.trim().length === 0) {
      return { error: "Search query cannot be empty", code: "INVALID_QUERY" };
    }
    const resolved = resolveWorkspacePath(workspaceRoot, requestedPath);
    const matches: Array<{ path: string; line?: number; text?: string }> = [];
    let bytes = 0;
    let truncated = false;
    const needle = query.toLowerCase();

    const visit = (dirReal: string): void => {
      if (matches.length >= MAX_SEARCH_RESULTS || bytes >= MAX_SEARCH_BYTES) {
        truncated = true;
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirReal, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_RESULTS || bytes >= MAX_SEARCH_BYTES) {
          truncated = true;
          return;
        }
        // Never follow directory symlinks during traversal (escape prevention).
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dirReal, entry.name);
        if (entry.isDirectory()) {
          if (SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
          visit(full);
        } else if (entry.isFile()) {
          const rel = path.relative(resolved.workspaceRootReal, full).split(path.sep).join("/");
          if (entry.name.toLowerCase().includes(needle) || rel.toLowerCase().includes(needle)) {
            matches.push({ path: rel });
            bytes += Buffer.byteLength(rel, "utf8");
            continue;
          }
          // Text match: skip large/binary files deterministically.
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (stat.size > MAX_READ_BYTES) continue;
          let text: string;
          try {
            text = fs.readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (text.includes("\0")) continue;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= MAX_SEARCH_RESULTS || bytes >= MAX_SEARCH_BYTES) {
              truncated = true;
              return;
            }
            if (lines[i].toLowerCase().includes(needle)) {
              const snippet = lines[i].slice(0, 240);
              matches.push({ path: rel, line: i + 1, text: snippet });
              bytes += Buffer.byteLength(snippet, "utf8");
            }
          }
        }
      }
    };

    const stat = fs.statSync(resolved.targetReal);
    if (stat.isFile()) {
      // Single-file search: text match only.
      const text = fs.readFileSync(resolved.targetReal, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_SEARCH_RESULTS) {
          truncated = true;
          break;
        }
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: resolved.relative, line: i + 1, text: lines[i].slice(0, 240) });
        }
      }
    } else {
      visit(resolved.targetReal);
    }
    return { matches, truncated };
  } catch (err: unknown) {
    return toError(err, "SEARCH_FAILED");
  }
}

export function isFilesystemError(value: unknown): value is FilesystemError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    "code" in value &&
    !("entries" in value) &&
    !("content" in value) &&
    !("bytesWritten" in value) &&
    !("matches" in value)
  );
}
