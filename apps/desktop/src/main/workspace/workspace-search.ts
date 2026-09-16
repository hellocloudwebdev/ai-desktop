// PR41: apps/desktop — Workspace Search Service
//
// Project-scoped, bounded, cancellable, symlink-safe content search.
// No second execution layer: a deterministic recursive walk over node:fs,
// mirroring the PR30 searchWorkspace traversal discipline (excluded dirs,
// no directory-symlink following, binary/large-file skips) with line/col
// detail, whole-word matching, and an AbortSignal cancellation contract.
//
// Invariants:
//   1. projectId first; unknown projects fail closed with NO_WORKSPACE.
//   2. EVERY path arg passes through resolveWorkspacePath; only targetReal
//      is ever handed to node:fs.
//   3. Cancellation throws a canonical abort error (name "AbortError") so
//      IPC serialization and callers see a stable shape.
//   4. Bounded: query length, maxResults cap, per-file size cap, line
//      snippet cap. Never unbounded buffers.

import fs from "node:fs";
import path from "node:path";
import { PathPolicyError, resolveWorkspacePath } from "../agent/filesystem/path-policy.js";
import { SEARCH_EXCLUDED_DIRS } from "../agent/filesystem/filesystem-tool-backend.js";
import { WorkspaceError } from "./workspace-errors.js";

export const WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS = 50;
export const WORKSPACE_SEARCH_MAX_RESULTS_CAP = 200;
export const WORKSPACE_SEARCH_MAX_FILE_BYTES = 256 * 1024;
export const WORKSPACE_SEARCH_SNIPPET_CHARS = 240;
export const WORKSPACE_SEARCH_CANCEL_CHECK_EVERY = 50;

export interface WorkspaceSearchServiceDeps {
  readonly resolveRoot: (projectId: string) => string | undefined;
}

export interface SearchInput {
  readonly projectId: string;
  readonly path?: string;
  readonly query: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly include?: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface SearchOutcome {
  readonly matches: SearchMatch[];
  readonly truncated: boolean;
  readonly searchedFiles: number;
}

export function createSearchCancelledError(): Error {
  return Object.assign(new Error("cancelled"), { name: "AbortError" });
}

export function isSearchCancelledError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError" &&
    err instanceof Error &&
    err.message === "cancelled"
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WorkspaceSearchService {
  private readonly _resolveRoot: (projectId: string) => string | undefined;

  constructor(deps: WorkspaceSearchServiceDeps) {
    this._resolveRoot = deps.resolveRoot;
  }

  search(input: SearchInput): SearchOutcome {
    const query = input.query;
    if (typeof query !== "string" || query.length === 0 || query.length > 200) {
      throw new WorkspaceError("INVALID", "Query must be 1..200 characters");
    }
    const root = this._resolveRoot(input.projectId);
    if (!root) {
      throw new WorkspaceError(
        "NO_WORKSPACE",
        `No workspace registered for project "${input.projectId}"`,
      );
    }
    const requestedPath = input.path ?? ".";
    let resolved: { workspaceRootReal: string; targetReal: string; relative: string };
    try {
      resolved = resolveWorkspacePath(root, requestedPath);
    } catch (err: unknown) {
      if (err instanceof PathPolicyError) {
        switch (err.code) {
          case "OUTSIDE_WORKSPACE":
            throw new WorkspaceError(
              "OUTSIDE_WORKSPACE",
              `Path "${requestedPath}" escapes the workspace`,
            );
          case "SYMLINK_ESCAPE":
            throw new WorkspaceError(
              "SYMLINK_ESCAPE",
              `Symlink "${requestedPath}" escapes the workspace`,
            );
          case "NOT_FOUND":
            throw new WorkspaceError("NOT_FOUND", `Path "${requestedPath}" does not exist`);
          default:
            throw new WorkspaceError("INVALID", `Invalid path "${requestedPath}"`);
        }
      }
      throw new WorkspaceError("INVALID", `Invalid path "${requestedPath}"`);
    }

    const maxResultsRaw = input.maxResults ?? WORKSPACE_SEARCH_DEFAULT_MAX_RESULTS;
    if (!Number.isInteger(maxResultsRaw) || maxResultsRaw <= 0) {
      throw new WorkspaceError("INVALID", "maxResults must be a positive integer");
    }
    const maxResults = Math.min(maxResultsRaw, WORKSPACE_SEARCH_MAX_RESULTS_CAP);
    const include = input.include && input.include.length > 0 ? input.include : undefined;

    const caseSensitive = input.caseSensitive ?? false;
    const pattern = query;
    const matcher = input.wholeWord
      ? new RegExp(`\\b${escapeRegExp(pattern)}\\b`, caseSensitive ? "g" : "gi")
      : null;
    const needle = caseSensitive ? pattern : pattern.toLowerCase();

    const matches: SearchMatch[] = [];
    let truncated = false;
    let searchedFiles = 0;
    let filesSinceCancelCheck = 0;
    const checkCancelled = (): void => {
      if (input.signal?.aborted) throw createSearchCancelledError();
    };
    const noteFileSearched = (): void => {
      searchedFiles += 1;
      filesSinceCancelCheck += 1;
      if (filesSinceCancelCheck >= WORKSPACE_SEARCH_CANCEL_CHECK_EVERY) {
        filesSinceCancelCheck = 0;
        checkCancelled();
      }
    };

    const scanFile = (fullReal: string, rel: string): void => {
      if (include !== undefined && !rel.includes(include)) {
        noteFileSearched();
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullReal);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size > WORKSPACE_SEARCH_MAX_FILE_BYTES) return;
      let text: string;
      try {
        const fd = fs.openSync(fullReal, "r");
        try {
          const probe = Buffer.alloc(Math.min(8192, stat.size));
          const read = fs.readSync(fd, probe, 0, probe.length, 0);
          if (probe.subarray(0, read).indexOf(0) !== -1) return;
        } finally {
          fs.closeSync(fd);
        }
        text = fs.readFileSync(fullReal, "utf8");
      } catch {
        return;
      }
      if (text.includes("\0")) return;
      noteFileSearched();
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
        const line = lines[i] ?? "";
        const column = findColumn(line, needle, matcher, caseSensitive);
        if (column !== -1) {
          matches.push({
            path: rel,
            line: i + 1,
            column: column + 1,
            text: line.slice(0, WORKSPACE_SEARCH_SNIPPET_CHARS),
          });
        }
      }
    };

    checkCancelled();
    let startStat: fs.Stats;
    try {
      startStat = fs.statSync(resolved.targetReal);
    } catch {
      throw new WorkspaceError("NOT_FOUND", `Path "${requestedPath}" does not exist`);
    }
    if (startStat.isFile()) {
      scanFile(resolved.targetReal, resolved.relative);
      return { matches, truncated, searchedFiles };
    }
    if (!startStat.isDirectory()) {
      throw new WorkspaceError("INVALID", `Not a searchable path: "${requestedPath}"`);
    }

    const stack: string[] = [resolved.targetReal];
    while (stack.length > 0) {
      checkCancelled();
      const current = stack.pop();
      if (!current) continue;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (matches.length >= maxResults) {
          truncated = true;
          return { matches, truncated, searchedFiles };
        }
        // Never follow symlinks during traversal (escape prevention).
        if (dirent.isSymbolicLink()) continue;
        const full = path.join(current, dirent.name);
        if (dirent.isDirectory()) {
          if (SEARCH_EXCLUDED_DIRS.has(dirent.name)) continue;
          stack.push(full);
        } else if (dirent.isFile()) {
          const rel = path.relative(resolved.workspaceRootReal, full).split(path.sep).join("/");
          scanFile(full, rel);
          if (truncated) return { matches, truncated, searchedFiles };
        }
      }
    }
    return { matches, truncated, searchedFiles };
  }
}

function findColumn(
  line: string,
  needle: string,
  wholeWord: RegExp | null,
  caseSensitive: boolean,
): number {
  if (wholeWord) {
    wholeWord.lastIndex = 0;
    const found = wholeWord.exec(line);
    return found ? (found.index ?? -1) : -1;
  }
  return caseSensitive ? line.indexOf(needle) : line.toLowerCase().indexOf(needle);
}
