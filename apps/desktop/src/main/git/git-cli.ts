// PR42: apps/desktop — Git CLI Client & Output Parsers
//
// Encapsulates the Git CLI execution boundary:
//   - Uses child_process.spawn with shell: false strictly (no command injection).
//   - Arguments are always passed as string arrays.
//   - Strict environment allowlist (PATH, SYSTEMROOT, TMP, TEMP, USERPROFILE, HOME).
//   - Forces non-interactive mode: GIT_TERMINAL_PROMPT=0, LC_ALL=C, GIT_OPTIONAL_LOCKS=0.
//   - Bounded stdout/stderr buffers with hard timeouts and AbortSignal cancellation.
//   - Robust format-separated output parsers for status, diff, log, and branches.

import { spawn } from "node:child_process";
import {
  GIT_MAX_BRANCHES,
  GIT_MAX_DIFF_BYTES,
  GIT_MAX_DIFF_FILES,
  GIT_MAX_DIFF_LINES,
  GIT_MAX_HUNK_LINES,
  GIT_MAX_LOG_ENTRIES,
  GIT_MAX_STATUS_FILES,
  GIT_COMMAND_TIMEOUT_MS,
  type GitBranch,
  type GitCommit,
  type GitDiff,
  type GitFileDiff,
  type GitFileStatus,
  type GitFileStatusKind,
  type GitDiffHunk,
} from "@ai-desktop/ai-core";
import { GitServiceError } from "./git-errors.js";

export interface GitExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitCliOptions {
  readonly gitBinary?: string;
  readonly maxBufferBytes?: number;
  readonly defaultTimeoutMs?: number;
}

const ALLOWED_ENV_VARS = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export class GitCliClient {
  private readonly _gitBinary: string;
  private readonly _maxBufferBytes: number;
  private readonly _defaultTimeoutMs: number;

  constructor(options?: GitCliOptions) {
    this._gitBinary = options?.gitBinary ?? "git";
    this._maxBufferBytes = options?.maxBufferBytes ?? GIT_MAX_DIFF_BYTES;
    this._defaultTimeoutMs = options?.defaultTimeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  }

  /**
   * Executes Git with array arguments in the specified repository root.
   * Never invokes a shell.
   */
  async exec(
    cwd: string,
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GitExecResult> {
    if (options?.signal?.aborted) {
      throw new GitServiceError("CANCELLED", "Git operation was cancelled before start");
    }

    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
    };

    for (const key of ALLOWED_ENV_VARS) {
      const val = process.env[key];
      if (val !== undefined) {
        env[key] = val;
      }
    }

    const timeoutMs = options?.timeoutMs ?? this._defaultTimeoutMs;

    return new Promise<GitExecResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let killed = false;
      let timedOut = false;
      let settled = false;

      const proc = spawn(this._gitBinary, args as string[], {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill("SIGKILL");
      }, timeoutMs);

      const abortListener = () => {
        killed = true;
        proc.kill("SIGKILL");
      };

      if (options?.signal) {
        options.signal.addEventListener("abort", abortListener, { once: true });
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this._maxBufferBytes) {
          if (settled) return;
          settled = true;
          killed = true;
          proc.kill("SIGKILL");
          clearTimeout(timer);
          if (options?.signal) {
            options.signal.removeEventListener("abort", abortListener);
          }
          reject(
            new GitServiceError(
              "COMMAND_FAILED",
              `Git output exceeded maximum buffer limit (${this._maxBufferBytes} bytes)`,
            ),
          );
          return;
        }
        stdout += chunk.toString("utf8");
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this._maxBufferBytes) {
          if (settled) return;
          settled = true;
          killed = true;
          proc.kill("SIGKILL");
          clearTimeout(timer);
          if (options?.signal) {
            options.signal.removeEventListener("abort", abortListener);
          }
          reject(
            new GitServiceError(
              "COMMAND_FAILED",
              `Git error output exceeded maximum buffer limit (${this._maxBufferBytes} bytes)`,
            ),
          );
          return;
        }
        stderr += chunk.toString("utf8");
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }
        reject(new GitServiceError("COMMAND_FAILED", `Failed to spawn git: ${err.message}`));
      });

      proc.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener("abort", abortListener);
        }

        if (timedOut) {
          reject(new GitServiceError("TIMEOUT", `Git command timed out after ${timeoutMs}ms`));
          return;
        }

        if (killed && options?.signal?.aborted) {
          reject(new GitServiceError("CANCELLED", "Git operation was cancelled"));
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? 0,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Output Parsers
  // ---------------------------------------------------------------------------

  /**
   * Parses porcelain v1 status output (`git status --porcelain=v1 -uall`).
   */
  parseStatus(porcelainOutput: string): {
    files: GitFileStatus[];
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    conflictedCount: number;
  } {
    const lines = porcelainOutput.split("\n");
    const files: GitFileStatus[] = [];
    let stagedCount = 0;
    let unstagedCount = 0;
    let untrackedCount = 0;
    let conflictedCount = 0;

    for (const rawLine of lines) {
      if (!rawLine || rawLine.length < 3) continue;

      const x = rawLine[0]!;
      const y = rawLine[1]!;
      const remainder = rawLine.slice(3).trim();

      let path = remainder;
      let oldPath: string | undefined;

      // Handle renames e.g. "R  old -> new"
      if (remainder.includes(" -> ")) {
        const parts = remainder.split(" -> ");
        oldPath = parts[0]?.replace(/^"|"$/g, "");
        path = parts[1]?.replace(/^"|"$/g, "") ?? remainder;
      } else {
        path = path.replace(/^"|"$/g, "");
      }

      const isConflicted =
        x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");

      const indexStatus = this._charToStatusKind(x);
      const workTreeStatus = this._charToStatusKind(y);
      const isUntracked = x === "?" && y === "?";
      const isStaged = x !== " " && x !== "?" && !isConflicted;

      if (isConflicted) conflictedCount++;
      else if (isUntracked) untrackedCount++;
      else {
        if (isStaged) stagedCount++;
        if (y !== " ") unstagedCount++;
      }

      files.push({
        path,
        ...(oldPath ? { oldPath } : {}),
        workingTree: isUntracked ? "untracked" : workTreeStatus,
        index: isUntracked ? "untracked" : indexStatus,
        staged: isStaged,
        conflicted: isConflicted,
      });
    }

    return {
      files: files.slice(0, GIT_MAX_STATUS_FILES),
      stagedCount,
      unstagedCount,
      untrackedCount,
      conflictedCount,
    };
  }

  private _charToStatusKind(c: string): GitFileStatusKind {
    switch (c) {
      case "M":
        return "modified";
      case "A":
        return "added";
      case "D":
        return "deleted";
      case "R":
        return "renamed";
      case "C":
        return "copied";
      case "?":
        return "untracked";
      case "!":
        return "ignored";
      case "U":
        return "conflicted";
      case " ":
      default:
        return "unmodified";
    }
  }

  /**
   * Parses unified diff output (`git diff` or `git diff --cached`).
   */
  parseDiff(rawDiff: string): GitDiff {
    if (!rawDiff.trim()) {
      return { files: [], totalAdditions: 0, totalDeletions: 0, truncated: false };
    }

    const fileChunks = rawDiff.split(/^diff --git /m).filter(Boolean);
    const files: GitFileDiff[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    let truncated = false;
    let totalDiffLines = 0;

    for (const chunk of fileChunks) {
      // Enforce max files bound (slice + truncated flag).
      if (files.length >= GIT_MAX_DIFF_FILES) {
        truncated = true;
        break;
      }
      const lines = chunk.split("\n");
      const headerLine = lines[0] ?? "";
      // Match "a/path b/path"
      const matchPaths = headerLine.match(/^a\/(.*?)\s+b\/(.*)$/);
      const oldPath = matchPaths ? matchPaths[1] : undefined;
      const path = matchPaths
        ? (matchPaths[2] ?? matchPaths[1]!)
        : (headerLine.split(" ")[0] ?? "unknown");

      const isBinary = /^Binary files .* differ/m.test(chunk) || chunk.includes("GIT binary patch");

      let fileStatus: GitFileStatusKind = "modified";
      if (chunk.includes("new file mode")) fileStatus = "added";
      else if (chunk.includes("deleted file mode")) fileStatus = "deleted";
      else if (chunk.includes("similarity index") && chunk.includes("rename from"))
        fileStatus = "renamed";

      const hunks: GitDiffHunk[] = [];
      let fileAdditions = 0;
      let fileDeletions = 0;

      if (!isBinary) {
        let currentHunk: GitDiffHunk | null = null;
        let oldLineCounter = 0;
        let newLineCounter = 0;

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]!;

          // Hunk header e.g. @@ -1,5 +1,13 @@ [optional header]
          const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
          if (hunkMatch) {
            if (currentHunk) {
              // Enforce per-hunk line bound defensively (slice + truncated flag).
              if (currentHunk.lines.length > GIT_MAX_HUNK_LINES) {
                currentHunk.lines = currentHunk.lines.slice(0, GIT_MAX_HUNK_LINES);
                truncated = true;
              }
              hunks.push(currentHunk);
            }
            const oldStart = parseInt(hunkMatch[1]!, 10);
            const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
            const newStart = parseInt(hunkMatch[3]!, 10);
            const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
            const header = (hunkMatch[5] ?? "").trim();

            oldLineCounter = oldStart;
            newLineCounter = newStart;

            currentHunk = {
              oldStart,
              oldLines,
              newStart,
              newLines,
              header: header || undefined,
              lines: [],
            };
            continue;
          }

          if (!currentHunk) continue;

          // Enforce total diff-lines bound: stop adding lines once capped.
          // Enforce per-hunk bound: slice lines per hunk.
          const atTotalCap = totalDiffLines >= GIT_MAX_DIFF_LINES;
          const atHunkCap = currentHunk.lines.length >= GIT_MAX_HUNK_LINES;
          // Process hunk lines
          if (line.startsWith("+") && !line.startsWith("+++")) {
            if (atTotalCap || atHunkCap) {
              truncated = true;
              newLineCounter++;
              continue;
            }
            currentHunk.lines.push({
              kind: "add",
              text: line.slice(1),
              newLineNumber: newLineCounter++,
            });
            fileAdditions++;
            totalAdditions++;
            totalDiffLines++;
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            if (atTotalCap || atHunkCap) {
              truncated = true;
              oldLineCounter++;
              continue;
            }
            currentHunk.lines.push({
              kind: "del",
              text: line.slice(1),
              oldLineNumber: oldLineCounter++,
            });
            fileDeletions++;
            totalDeletions++;
            totalDiffLines++;
          } else if (line.startsWith(" ")) {
            if (atTotalCap || atHunkCap) {
              truncated = true;
              oldLineCounter++;
              newLineCounter++;
              continue;
            }
            currentHunk.lines.push({
              kind: "context",
              text: line.slice(1),
              oldLineNumber: oldLineCounter++,
              newLineNumber: newLineCounter++,
            });
            totalDiffLines++;
          }
        }

        if (currentHunk) {
          // Enforce per-hunk line bound defensively (slice + truncated flag).
          if (currentHunk.lines.length > GIT_MAX_HUNK_LINES) {
            currentHunk.lines = currentHunk.lines.slice(0, GIT_MAX_HUNK_LINES);
            truncated = true;
          }
          hunks.push(currentHunk);
        }
      }

      files.push({
        path: path.replace(/^"|"$/g, ""),
        oldPath: oldPath ? oldPath.replace(/^"|"$/g, "") : undefined,
        status: fileStatus,
        isBinary,
        additions: fileAdditions,
        deletions: fileDeletions,
        hunks,
      });
    }

    return {
      files,
      totalAdditions,
      totalDeletions,
      truncated,
    };
  }

  /**
   * Parses git log format output with delimiter separators:
   * `%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1e`
   */
  parseLog(rawLog: string): GitCommit[] {
    if (!rawLog.trim()) return [];

    const records = rawLog.split("\x1e").filter((r) => r.trim());
    const commits: GitCommit[] = [];

    for (const rec of records) {
      const fields = rec.trim().split("\x1f");
      if (fields.length < 8) continue;

      const [sha, shortSha, authorName, authorEmail, timestamp, summary, body, parentsRaw] = fields;

      const message = body?.trim() ? `${summary}\n\n${body.trim()}` : (summary ?? "");
      const parents = parentsRaw?.trim() ? parentsRaw.trim().split(" ") : [];

      commits.push({
        sha: sha!.trim(),
        shortSha: shortSha!.trim(),
        author: {
          name: authorName!.trim(),
          email: authorEmail!.trim(),
          timestamp: timestamp!.trim(),
        },
        message,
        summary: summary!.trim(),
        parents,
      });
    }

    // Defensive bound even though callers pass -n <limit>.
    return commits.slice(0, GIT_MAX_LOG_ENTRIES);
  }

  /**
   * Parses git branch format output:
   * `git branch -a --format=%(HEAD)%x1f%(refname:short)%x1f%(objectname:short)%x1f%(upstream:short)%x1f%(upstream:track)`
   */
  parseBranches(rawOutput: string): {
    branches: GitBranch[];
    currentBranch?: string;
    detached: boolean;
  } {
    if (!rawOutput.trim()) {
      return { branches: [], detached: false };
    }

    const lines = rawOutput.split("\n").filter((l) => l.trim());
    const branches: GitBranch[] = [];
    let currentBranch: string | undefined;
    let detached = false;

    for (const line of lines) {
      const [headMark, name, commitSha, upstream, track] = line.split("\x1f");
      if (!name) continue;

      const isCurrent = headMark?.trim() === "*";
      const cleanName = name.trim();

      if (isCurrent) {
        if (cleanName.includes("HEAD detached")) {
          detached = true;
          currentBranch = commitSha?.trim() ?? "HEAD";
        } else {
          currentBranch = cleanName;
        }
      }

      let ahead = 0;
      let behind = 0;
      if (track) {
        const aheadMatch = track.match(/ahead (\d+)/);
        const behindMatch = track.match(/behind (\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1]!, 10);
        if (behindMatch) behind = parseInt(behindMatch[1]!, 10);
      }

      branches.push({
        name: cleanName,
        current: isCurrent,
        commitSha: commitSha?.trim() || undefined,
        upstream: upstream?.trim() || undefined,
        ahead: ahead > 0 ? ahead : undefined,
        behind: behind > 0 ? behind : undefined,
      });
    }

    return {
      branches: branches.slice(0, GIT_MAX_BRANCHES),
      currentBranch,
      detached,
    };
  }
}
