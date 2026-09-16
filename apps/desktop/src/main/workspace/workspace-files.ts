// PR41: apps/desktop — Workspace File Service
//
// Project-scoped file operations over the PR30 path policy + backend.
// No second filesystem layer: resolution goes through resolveWorkspacePath
// and reads/writes delegate to the filesystem-tool-backend; this service
// adds project binding, tree listing, binary detection, mtime conflict
// detection, and typed WorkspaceError mapping.
//
// Invariants:
//   1. projectId is always first; the root comes from the caller's
//      resolveRoot (CodingAgentService.resolveWorkspace in production).
//      Unknown projects fail closed with NO_WORKSPACE.
//   2. EVERY path arg passes through resolveWorkspacePath; only targetReal
//      is ever handed to node:fs — never raw input.
//   3. All failures surface as typed WorkspaceError, never raw exceptions
//      or absolute main-side paths.
//   4. Bounded: per-dir/total list caps, read/write byte caps, delete cap.

import fs from "node:fs";
import path from "node:path";
import {
  PathPolicyError,
  resolveWorkspacePath,
  type ResolvedWorkspacePath,
} from "../agent/filesystem/path-policy.js";
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  SEARCH_EXCLUDED_DIRS,
  readFile as backendReadFile,
  writeFile as backendWriteFile,
  type FilesystemError,
} from "../agent/filesystem/filesystem-tool-backend.js";
import { WorkspaceError } from "./workspace-errors.js";

export const WORKSPACE_LIST_DEFAULT_DEPTH = 2;
export const WORKSPACE_LIST_MAX_DEPTH = 4;
export const WORKSPACE_LIST_PER_DIR_CAP = 500;
export const WORKSPACE_LIST_TOTAL_CAP = 2000;
export const WORKSPACE_DELETE_ENTRY_CAP = 1000;
export const WORKSPACE_BINARY_PROBE_BYTES = 8192;

export interface WorkspaceFileServiceDeps {
  readonly resolveRoot: (projectId: string) => string | undefined;
}

export interface TreeEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly path: string;
  readonly size?: number;
}

export interface ListTreeInput {
  readonly projectId: string;
  readonly path?: string;
  readonly depth?: number;
}

export interface ListTreeResult {
  readonly path: string;
  readonly entries: TreeEntry[];
  readonly truncated: boolean;
}

export interface ReadFileInput {
  readonly projectId: string;
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxBytes?: number;
}

export interface ReadFileResult {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly totalLines: number;
  readonly mtimeMs: number;
}

export interface WriteFileInput {
  readonly projectId: string;
  readonly path: string;
  readonly content: string;
  readonly expectedMtimeMs?: number;
}

export interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
  readonly mtimeMs: number;
}

export interface CreateFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly mtimeMs: number;
}

export interface CreateDirectoryResult {
  readonly path: string;
  readonly created: boolean;
}

export interface RenameResult {
  readonly from: string;
  readonly to: string;
}

export interface DeleteResult {
  readonly path: string;
  readonly deleted: boolean;
  readonly entriesRemoved: number;
}

export interface FileStatus {
  readonly exists: boolean;
  readonly kind?: "file" | "directory" | "other";
  readonly size?: number;
  readonly mtimeMs?: number;
}

/**
 * Maps a backend FilesystemError result (already policy-checked) onto a
 * typed WorkspaceError without leaking absolute paths.
 */
function mapBackendError(failure: FilesystemError): WorkspaceError {
  switch (failure.code) {
    case "OUTSIDE_WORKSPACE":
      return new WorkspaceError("OUTSIDE_WORKSPACE", "Path escapes the workspace");
    case "SYMLINK_ESCAPE":
      return new WorkspaceError("SYMLINK_ESCAPE", "Symlink target escapes the workspace");
    case "NOT_FOUND":
      return new WorkspaceError("NOT_FOUND", "Path does not exist");
    case "FILE_TOO_LARGE":
    case "WRITE_TOO_LARGE":
      return new WorkspaceError("TOO_LARGE", "File exceeds the size bound");
    case "IS_DIRECTORY":
      return new WorkspaceError("IS_DIRECTORY", "Target is a directory");
    default:
      return new WorkspaceError("INVALID", "Invalid workspace path or operation");
  }
}

function mapThrown(requested: string, err: unknown): WorkspaceError {
  if (err instanceof WorkspaceError) return err;
  if (err instanceof PathPolicyError) {
    switch (err.code) {
      case "OUTSIDE_WORKSPACE":
        return new WorkspaceError("OUTSIDE_WORKSPACE", `Path "${requested}" escapes the workspace`);
      case "SYMLINK_ESCAPE":
        return new WorkspaceError("SYMLINK_ESCAPE", `Symlink "${requested}" escapes the workspace`);
      case "NOT_FOUND":
        return new WorkspaceError("NOT_FOUND", `Path "${requested}" does not exist`);
      case "INVALID_PATH":
        return new WorkspaceError("INVALID", `Invalid path "${requested}"`);
    }
  }
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") {
    return new WorkspaceError("NOT_FOUND", `Path "${requested}" does not exist`);
  }
  if (code === "EISDIR") {
    return new WorkspaceError("IS_DIRECTORY", `Target "${requested}" is a directory`);
  }
  return new WorkspaceError("INVALID", `Invalid workspace operation on "${requested}"`);
}

export class WorkspaceFileService {
  private readonly _resolveRoot: (projectId: string) => string | undefined;

  constructor(deps: WorkspaceFileServiceDeps) {
    this._resolveRoot = deps.resolveRoot;
  }

  private _rootFor(projectId: string): string {
    const root = this._resolveRoot(projectId);
    if (!root) {
      throw new WorkspaceError(
        "NO_WORKSPACE",
        `No workspace registered for project "${projectId}"`,
      );
    }
    return root;
  }

  private _resolve(projectId: string, requestedPath: string): ResolvedWorkspacePath {
    const root = this._rootFor(projectId);
    try {
      return resolveWorkspacePath(root, requestedPath);
    } catch (err: unknown) {
      throw mapThrown(requestedPath, err);
    }
  }

  /**
   * Rejects symlink final components whose link target escapes the
   * workspace. Non-dangling escapes are already rejected by
   * resolveWorkspacePath (OUTSIDE_WORKSPACE); this guard catches dangling
   * links, which resolve through the missing-tail path, and any link the
   * caller is about to overwrite or remove.
   */
  private _guardSymlink(resolved: ResolvedWorkspacePath, requestedPath: string): void {
    let link: fs.Stats;
    try {
      link = fs.lstatSync(resolved.targetReal);
    } catch {
      return;
    }
    if (!link.isSymbolicLink()) return;
    let target: string;
    try {
      target = fs.readlinkSync(resolved.targetReal);
    } catch {
      return;
    }
    const absolute = path.isAbsolute(target)
      ? path.normalize(target)
      : path.join(path.dirname(resolved.targetReal), target);
    let targetReal: string;
    try {
      targetReal = fs.realpathSync(absolute);
    } catch {
      // Dangling link with an unresolvable tail: compare the raw target.
      targetReal = absolute;
    }
    const rootReal = resolved.workspaceRootReal;
    const inside =
      targetReal === rootReal ||
      targetReal.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
    if (!inside) {
      throw new WorkspaceError(
        "SYMLINK_ESCAPE",
        `Symlink "${requestedPath}" escapes the workspace`,
      );
    }
  }

  listTree(input: ListTreeInput): ListTreeResult {
    const start = input.path ?? ".";
    const rawDepth = input.depth ?? WORKSPACE_LIST_DEFAULT_DEPTH;
    if (!Number.isInteger(rawDepth) || rawDepth < 0) {
      throw new WorkspaceError("INVALID", "Depth must be a non-negative integer");
    }
    const depth = Math.min(rawDepth, WORKSPACE_LIST_MAX_DEPTH);
    const resolved = this._resolve(input.projectId, start);
    let startStat: fs.Stats;
    try {
      startStat = fs.statSync(resolved.targetReal);
    } catch (err: unknown) {
      throw mapThrown(start, err);
    }
    if (!startStat.isDirectory()) {
      throw new WorkspaceError("INVALID", `Not a directory: "${resolved.relative}"`);
    }

    const entries: TreeEntry[] = [];
    let truncated = false;
    const stack: Array<{ dirReal: string; remaining: number }> = [
      { dirReal: resolved.targetReal, remaining: depth },
    ];
    const rootReal = resolved.workspaceRootReal;

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || current.remaining <= 0) continue;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(current.dirReal, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      if (dirents.length > WORKSPACE_LIST_PER_DIR_CAP) {
        dirents = dirents.slice(0, WORKSPACE_LIST_PER_DIR_CAP);
        truncated = true;
      }
      for (const dirent of dirents) {
        if (entries.length >= WORKSPACE_LIST_TOTAL_CAP) {
          truncated = true;
          return { path: resolved.relative, entries, truncated };
        }
        // Never follow directory symlinks during traversal (escape prevention,
        // mirroring searchWorkspace); symlinked files are skipped as well so
        // no outside metadata is ever stat-ed.
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory() && SEARCH_EXCLUDED_DIRS.has(dirent.name)) continue;
        const full = path.join(current.dirReal, dirent.name);
        const rel = path.relative(rootReal, full).split(path.sep).join("/");
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, kind: "directory", path: rel });
          stack.push({ dirReal: full, remaining: current.remaining - 1 });
        } else if (dirent.isFile()) {
          let size: number | undefined;
          try {
            size = fs.statSync(full).size;
          } catch {
            size = undefined;
          }
          entries.push(
            size === undefined
              ? { name: dirent.name, kind: "file", path: rel }
              : { name: dirent.name, kind: "file", path: rel, size },
          );
        }
      }
    }
    return { path: resolved.relative, entries, truncated };
  }

  readFile(input: ReadFileInput): ReadFileResult {
    if (
      input.maxBytes !== undefined &&
      (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0)
    ) {
      throw new WorkspaceError("INVALID", "maxBytes must be a positive integer");
    }
    const resolved = this._resolve(input.projectId, input.path);
    this._guardSymlink(resolved, input.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved.targetReal);
    } catch (err: unknown) {
      throw mapThrown(input.path, err);
    }
    if (stat.isDirectory()) {
      throw new WorkspaceError("IS_DIRECTORY", `Target "${resolved.relative}" is a directory`);
    }
    if (!stat.isFile()) {
      throw new WorkspaceError("INVALID", `Not a file: "${resolved.relative}"`);
    }
    if (this._hasNulByte(resolved.targetReal)) {
      throw new WorkspaceError("BINARY_FILE", `File "${resolved.relative}" appears to be binary`);
    }
    const outcome = backendReadFile(
      resolved.workspaceRootReal,
      resolved.relative,
      input.startLine,
      input.endLine,
    );
    if ("error" in outcome) {
      throw mapBackendError(outcome);
    }
    const maxBytes = input.maxBytes ?? MAX_READ_BYTES;
    let content = outcome.content;
    let truncated = outcome.truncated;
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      content = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
      truncated = true;
    }
    return {
      path: outcome.path,
      content,
      truncated,
      totalLines: outcome.totalLines,
      mtimeMs: stat.mtimeMs,
    };
  }

  writeFile(input: WriteFileInput): WriteFileResult {
    if (typeof input.content !== "string") {
      throw new WorkspaceError("INVALID", "Content must be a string");
    }
    const resolved = this._resolve(input.projectId, input.path);
    this._guardSymlink(resolved, input.path);
    if (input.expectedMtimeMs !== undefined) {
      let current: fs.Stats | undefined;
      try {
        current = fs.statSync(resolved.targetReal);
      } catch {
        current = undefined;
      }
      if (current && current.isFile() && current.mtimeMs !== input.expectedMtimeMs) {
        throw new WorkspaceError(
          "EXTERNAL_MODIFIED",
          `File "${resolved.relative}" changed on disk; reload before overwriting`,
        );
      }
    }
    const outcome = backendWriteFile(resolved.workspaceRootReal, resolved.relative, input.content);
    if ("error" in outcome) {
      throw mapBackendError(outcome);
    }
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(resolved.targetReal).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return {
      path: outcome.path,
      bytesWritten: outcome.bytesWritten,
      created: outcome.created,
      mtimeMs,
    };
  }

  createFile(input: WriteFileInput): CreateFileResult {
    if (typeof input.content !== "string") {
      throw new WorkspaceError("INVALID", "Content must be a string");
    }
    const resolved = this._resolve(input.projectId, input.path);
    this._guardSymlink(resolved, input.path);
    let existing: fs.Stats | undefined;
    try {
      existing = fs.statSync(resolved.targetReal);
    } catch {
      existing = undefined;
    }
    if (existing) {
      throw new WorkspaceError("INVALID", `Path "${resolved.relative}" already exists`);
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_WRITE_BYTES) {
      throw new WorkspaceError("TOO_LARGE", "File exceeds the size bound");
    }
    try {
      fs.mkdirSync(path.dirname(resolved.targetReal), { recursive: true });
      fs.writeFileSync(resolved.targetReal, input.content, "utf8");
    } catch (err: unknown) {
      throw mapThrown(input.path, err);
    }
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(resolved.targetReal).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return { path: resolved.relative, bytesWritten: bytes, mtimeMs };
  }

  createDirectory(input: ListTreeInput): CreateDirectoryResult {
    const requested = input.path ?? ".";
    const resolved = this._resolve(input.projectId, requested);
    let existing: fs.Stats | undefined;
    try {
      existing = fs.statSync(resolved.targetReal);
    } catch {
      existing = undefined;
    }
    if (existing) {
      throw new WorkspaceError("INVALID", `Path "${resolved.relative}" already exists`);
    }
    try {
      fs.mkdirSync(resolved.targetReal, { recursive: true });
    } catch (err: unknown) {
      throw mapThrown(requested, err);
    }
    return { path: resolved.relative, created: true };
  }

  rename(input: { projectId: string; from: string; to: string }): RenameResult {
    const src = this._resolve(input.projectId, input.from);
    this._guardSymlink(src, input.from);
    let srcStat: fs.Stats | undefined;
    try {
      srcStat = fs.statSync(src.targetReal);
    } catch {
      srcStat = undefined;
    }
    if (!srcStat) {
      throw new WorkspaceError("NOT_FOUND", `Path "${input.from}" does not exist`);
    }
    const dst = this._resolve(input.projectId, input.to);
    if (dst.targetReal === src.targetReal) {
      throw new WorkspaceError("INVALID", "Source and destination are the same path");
    }
    if (fs.existsSync(dst.targetReal)) {
      throw new WorkspaceError("INVALID", `Destination "${dst.relative}" already exists`);
    }
    try {
      fs.mkdirSync(path.dirname(dst.targetReal), { recursive: true });
      fs.renameSync(src.targetReal, dst.targetReal);
    } catch (err: unknown) {
      throw mapThrown(input.to, err);
    }
    return { from: src.relative, to: dst.relative };
  }

  delete(input: { projectId: string; path: string }): DeleteResult {
    const resolved = this._resolve(input.projectId, input.path);
    if (resolved.targetReal === resolved.workspaceRootReal) {
      throw new WorkspaceError("INVALID", "Cannot delete the workspace root");
    }
    this._guardSymlink(resolved, input.path);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(resolved.targetReal);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      throw new WorkspaceError("NOT_FOUND", `Path "${input.path}" does not exist`);
    }
    if (!stat.isDirectory()) {
      try {
        fs.rmSync(resolved.targetReal, { force: true });
      } catch (err: unknown) {
        throw mapThrown(input.path, err);
      }
      return { path: resolved.relative, deleted: true, entriesRemoved: 1 };
    }
    const count = this._countEntries(resolved.targetReal);
    if (count > WORKSPACE_DELETE_ENTRY_CAP) {
      throw new WorkspaceError(
        "TOO_LARGE",
        `Directory holds ${count} entries (cap ${WORKSPACE_DELETE_ENTRY_CAP})`,
      );
    }
    try {
      fs.rmSync(resolved.targetReal, { recursive: true, force: true });
    } catch (err: unknown) {
      throw mapThrown(input.path, err);
    }
    return { path: resolved.relative, deleted: true, entriesRemoved: count };
  }

  getStatus(input: { projectId: string; path: string }): FileStatus {
    const resolved = this._resolve(input.projectId, input.path);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(resolved.targetReal);
    } catch {
      return { exists: false };
    }
    return {
      exists: true,
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  private _hasNulByte(targetReal: string): boolean {
    let fd = -1;
    try {
      fd = fs.openSync(targetReal, "r");
      const buf = Buffer.alloc(WORKSPACE_BINARY_PROBE_BYTES);
      const read = fs.readSync(fd, buf, 0, WORKSPACE_BINARY_PROBE_BYTES, 0);
      return buf.subarray(0, read).indexOf(0) !== -1;
    } catch {
      return false;
    } finally {
      if (fd !== -1) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close failures on a probe handle.
        }
      }
    }
  }

  private _countEntries(dirReal: string): number {
    let count = 1;
    const stack: string[] = [dirReal];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) {
          count += 1;
          continue;
        }
        count += 1;
        if (count > WORKSPACE_DELETE_ENTRY_CAP) return count;
        if (dirent.isDirectory() && !SEARCH_EXCLUDED_DIRS.has(dirent.name)) {
          stack.push(path.join(current, dirent.name));
        }
      }
    }
    return count;
  }
}
