// PR42: apps/desktop — Git Service
//
// Desktop-side Git service orchestrating repository detection, status inspection,
// diffing, commit history, staging, unstaging, and commit creation.
//
// Security invariants:
//   1. Every operation is scoped to an authorized project workspace root.
//   2. File paths are strictly validated through resolveWorkspacePath and
//      assertNoSymlinkEscape to prevent traversal or symlink escape.
//   3. Non-interactive CLI flags prevent hanging on credential or merge prompts.
//   4. Output buffers and timeouts are bounded.
//   5. Non-git projects fail cleanly with isRepo: false without throwing application crashes.

import fs from "node:fs";
import path from "node:path";
import {
  GIT_MAX_COMMIT_MSG_BYTES,
  GIT_MAX_LOG_ENTRIES,
  GIT_MAX_STAGE_PATHS,
  type GitBranch,
  type GitDiff,
  type GitLog,
  type GitOperationResult,
  type GitRepository,
  type GitStatus,
} from "@ai-desktop/ai-core";
import {
  assertNoSymlinkEscape,
  PathPolicyError,
  resolveWorkspacePath,
} from "../agent/filesystem/path-policy.js";
import { GitCliClient } from "./git-cli.js";
import { GitServiceError, toCanonicalGitError } from "./git-errors.js";

export interface GitServiceDeps {
  readonly resolveRoot: (projectId: string) => string | undefined;
  readonly gitCli?: GitCliClient;
}

export class GitService {
  private readonly _resolveRoot: (projectId: string) => string | undefined;
  private readonly _cli: GitCliClient;

  constructor(deps: GitServiceDeps) {
    this._resolveRoot = deps.resolveRoot;
    this._cli = deps.gitCli ?? new GitCliClient();
  }

  // ---------------------------------------------------------------------------
  // Workspace & Path Helpers
  // ---------------------------------------------------------------------------

  private _requireWorkspace(projectId: string): string {
    const root = this._resolveRoot(projectId);
    if (!root) {
      throw new GitServiceError(
        "NO_WORKSPACE",
        `No workspace registered for project "${projectId}"`,
      );
    }
    return root;
  }

  private _validatePaths(workspaceRoot: string, paths: readonly string[]): string[] {
    if (!paths || paths.length === 0) {
      throw new GitServiceError("INVALID_PATH", "At least one path must be specified");
    }
    if (paths.length > GIT_MAX_STAGE_PATHS) {
      throw new GitServiceError(
        "INVALID_PATH",
        `Number of paths (${paths.length}) exceeds maximum (${GIT_MAX_STAGE_PATHS})`,
      );
    }

    const validRelatives: string[] = [];
    for (const p of paths) {
      try {
        const resolved = resolveWorkspacePath(workspaceRoot, p);
        assertNoSymlinkEscape(workspaceRoot, resolved.targetReal);
        validRelatives.push(resolved.relative === "." ? "." : resolved.relative);
      } catch (err) {
        if (err instanceof PathPolicyError) {
          if (err.code === "OUTSIDE_WORKSPACE") {
            throw new GitServiceError(
              "PATH_OUTSIDE_WORKSPACE",
              `Path "${p}" is outside the project workspace`,
            );
          }
          if (err.code === "SYMLINK_ESCAPE") {
            throw new GitServiceError(
              "SYMLINK_ESCAPE",
              `Path "${p}" escapes workspace via symlink`,
            );
          }
        }
        throw new GitServiceError("INVALID_PATH", `Invalid path "${p}"`);
      }
    }
    return validRelatives;
  }

  // ---------------------------------------------------------------------------
  // Repository Detection & Inspection
  // ---------------------------------------------------------------------------

  async detectRepository(projectId: string, signal?: AbortSignal): Promise<GitRepository> {
    const root = this._requireWorkspace(projectId);

    try {
      const isInside = await this._cli.exec(root, ["rev-parse", "--is-inside-work-tree"], {
        signal,
        timeoutMs: 5000,
      });

      if (isInside.exitCode !== 0 || !isInside.stdout.trim().includes("true")) {
        return {
          isRepo: false,
          detached: false,
          empty: false,
        };
      }

      // Check root path
      const topLevel = await this._cli.exec(root, ["rev-parse", "--show-toplevel"], {
        signal,
        timeoutMs: 5000,
      });
      const rootPath = topLevel.stdout.trim() || root;

      // Check branch and commit
      let currentBranch: string | undefined;
      let detached = false;
      let headSha: string | undefined;
      let empty = false;

      const branchRes = await this._cli.exec(root, ["rev-parse", "--abbrev-ref", "HEAD"], {
        signal,
        timeoutMs: 5000,
      });

      if (branchRes.exitCode === 0) {
        const branchName = branchRes.stdout.trim();
        if (branchName === "HEAD") {
          detached = true;
        } else {
          currentBranch = branchName;
        }
      }

      const headRes = await this._cli.exec(root, ["rev-parse", "HEAD"], {
        signal,
        timeoutMs: 5000,
      });
      if (headRes.exitCode === 0) {
        headSha = headRes.stdout.trim();
      } else {
        // Head cannot be resolved, likely an empty repository
        empty = true;
      }

      // Empty repo: `rev-parse --abbrev-ref HEAD` exits 128, so resolve the
      // unborn branch name via symbolic-ref (fallback: branch --show-current).
      if (empty && !currentBranch && !detached) {
        try {
          const symRes = await this._cli.exec(root, ["symbolic-ref", "--short", "HEAD"], {
            signal,
            timeoutMs: 5000,
          });
          if (symRes.exitCode === 0 && symRes.stdout.trim()) {
            currentBranch = symRes.stdout.trim();
          } else {
            const showRes = await this._cli.exec(root, ["branch", "--show-current"], {
              signal,
              timeoutMs: 5000,
            });
            if (showRes.exitCode === 0 && showRes.stdout.trim()) {
              currentBranch = showRes.stdout.trim();
            }
          }
        } catch {
          // Fall back to undefined — branch name stays unknown on empty repo.
        }
      }

      return {
        isRepo: true,
        rootPath,
        currentBranch,
        detached,
        headSha,
        empty,
      };
    } catch {
      if (signal?.aborted) {
        throw new GitServiceError("CANCELLED", "Repository detection cancelled");
      }
      return {
        isRepo: false,
        detached: false,
        empty: false,
      };
    }
  }

  async getStatus(projectId: string, signal?: AbortSignal): Promise<GitStatus> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, signal);

    if (!repoInfo.isRepo) {
      return {
        isRepo: false,
        ahead: 0,
        behind: 0,
        detached: false,
        clean: true,
        files: [],
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
      };
    }

    try {
      const statusRes = await this._cli.exec(root, ["status", "--porcelain=v1", "-uall"], {
        signal,
      });

      if (statusRes.exitCode !== 0) {
        throw new GitServiceError("COMMAND_FAILED", `git status failed: ${statusRes.stderr}`);
      }

      const parsed = this._cli.parseStatus(statusRes.stdout);

      // Check ahead / behind / upstream
      let upstream: string | undefined;
      let ahead = 0;
      let behind = 0;

      if (!repoInfo.empty && !repoInfo.detached && repoInfo.currentBranch) {
        const branchRes = await this._cli.exec(root, ["rev-parse", "--abbrev-ref", "@{upstream}"], {
          signal,
          timeoutMs: 5000,
        });

        if (branchRes.exitCode === 0 && branchRes.stdout.trim()) {
          upstream = branchRes.stdout.trim();
          const countRes = await this._cli.exec(
            root,
            ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            { signal, timeoutMs: 5000 },
          );
          if (countRes.exitCode === 0) {
            const counts = countRes.stdout.trim().split(/\s+/);
            ahead = parseInt(counts[0] ?? "0", 10) || 0;
            behind = parseInt(counts[1] ?? "0", 10) || 0;
          }
        }
      }

      const isClean =
        parsed.files.length === 0 &&
        parsed.stagedCount === 0 &&
        parsed.unstagedCount === 0 &&
        parsed.untrackedCount === 0 &&
        parsed.conflictedCount === 0;

      return {
        isRepo: true,
        branch: repoInfo.currentBranch,
        upstream,
        ahead,
        behind,
        detached: repoInfo.detached,
        clean: isClean,
        files: parsed.files,
        stagedCount: parsed.stagedCount,
        unstagedCount: parsed.unstagedCount,
        untrackedCount: parsed.untrackedCount,
        conflictedCount: parsed.conflictedCount,
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof GitServiceError && err.gitCode === "CANCELLED")) {
        throw new GitServiceError("CANCELLED", "Git status was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  async getDiff(
    projectId: string,
    options?: { staged?: boolean; path?: string; signal?: AbortSignal },
  ): Promise<GitDiff> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, options?.signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    const args = ["diff", "--no-color", "-p"];
    if (options?.staged) {
      args.push("--cached");
    }

    if (options?.path) {
      const valid = this._validatePaths(root, [options.path]);
      args.push("--", valid[0]!);
    }

    try {
      const diffRes = await this._cli.exec(root, args, { signal: options?.signal });
      if (diffRes.exitCode !== 0) {
        throw new GitServiceError("COMMAND_FAILED", `git diff failed: ${diffRes.stderr}`);
      }

      return this._cli.parseDiff(diffRes.stdout);
    } catch (err) {
      if (
        options?.signal?.aborted ||
        (err instanceof GitServiceError && err.gitCode === "CANCELLED")
      ) {
        throw new GitServiceError("CANCELLED", "Git diff was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  async getLog(
    projectId: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<GitLog> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, options?.signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    if (repoInfo.empty) {
      return { commits: [], total: 0 };
    }

    const limit = Math.min(Math.max(1, options?.limit ?? 20), GIT_MAX_LOG_ENTRIES);
    const format = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%P%x1e";
    const args = ["log", `-n${limit}`, `--format=${format}`];

    try {
      const logRes = await this._cli.exec(root, args, { signal: options?.signal });
      if (logRes.exitCode !== 0) {
        // If repo has no commits yet
        if (logRes.stderr.includes("does not have any commits")) {
          return { commits: [], total: 0 };
        }
        throw new GitServiceError("COMMAND_FAILED", `git log failed: ${logRes.stderr}`);
      }

      const commits = this._cli.parseLog(logRes.stdout);
      return {
        commits,
        total: commits.length,
      };
    } catch (err) {
      if (
        options?.signal?.aborted ||
        (err instanceof GitServiceError && err.gitCode === "CANCELLED")
      ) {
        throw new GitServiceError("CANCELLED", "Git log was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  async getBranches(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<{ branches: GitBranch[]; currentBranch?: string; detached: boolean }> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    const format =
      "%(HEAD)%x1f%(refname:short)%x1f%(objectname:short)%x1f%(upstream:short)%x1f%(upstream:track)";
    const args = ["branch", "--format=" + format];

    try {
      const branchRes = await this._cli.exec(root, args, { signal });
      if (branchRes.exitCode !== 0) {
        throw new GitServiceError("COMMAND_FAILED", `git branch failed: ${branchRes.stderr}`);
      }

      return this._cli.parseBranches(branchRes.stdout);
    } catch (err) {
      if (signal?.aborted || (err instanceof GitServiceError && err.gitCode === "CANCELLED")) {
        throw new GitServiceError("CANCELLED", "Git branch list was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Mutating Operations (Stage / Unstage / Commit / Discard)
  // ---------------------------------------------------------------------------

  async stage(
    projectId: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitOperationResult> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    const validatedPaths = this._validatePaths(root, paths);
    const args = ["add", "-A", "--", ...validatedPaths];

    try {
      const addRes = await this._cli.exec(root, args, { signal });
      if (addRes.exitCode !== 0) {
        throw new GitServiceError("COMMAND_FAILED", `git add failed: ${addRes.stderr}`);
      }

      return {
        success: true,
        message: `Staged ${validatedPaths.length} path(s)`,
        affectedPaths: validatedPaths,
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof GitServiceError && err.gitCode === "CANCELLED")) {
        throw new GitServiceError("CANCELLED", "Git stage was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  async unstage(
    projectId: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitOperationResult> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    const validatedPaths = this._validatePaths(root, paths);

    try {
      // First try restore --staged (modern Git)
      const restoreRes = await this._cli.exec(
        root,
        ["restore", "--staged", "--", ...validatedPaths],
        { signal },
      );

      if (restoreRes.exitCode === 0) {
        return {
          success: true,
          message: `Unstaged ${validatedPaths.length} path(s)`,
          affectedPaths: validatedPaths,
        };
      }

      // Fall back to reset HEAD -- paths
      const resetRes = await this._cli.exec(root, ["reset", "HEAD", "--", ...validatedPaths], {
        signal,
      });

      if (resetRes.exitCode !== 0) {
        throw new GitServiceError("COMMAND_FAILED", `git unstage failed: ${resetRes.stderr}`);
      }

      return {
        success: true,
        message: `Unstaged ${validatedPaths.length} path(s)`,
        affectedPaths: validatedPaths,
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof GitServiceError && err.gitCode === "CANCELLED")) {
        throw new GitServiceError("CANCELLED", "Git unstage was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  async commit(
    projectId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<GitOperationResult> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    const cleanMsg = message.trim();
    if (!cleanMsg) {
      throw new GitServiceError("EMPTY_COMMIT_MESSAGE", "Commit message cannot be empty");
    }
    if (Buffer.byteLength(cleanMsg, "utf8") > GIT_MAX_COMMIT_MSG_BYTES) {
      throw new GitServiceError(
        "COMMIT_FAILED",
        `Commit message exceeds maximum size of ${GIT_MAX_COMMIT_MSG_BYTES} bytes`,
      );
    }

    // Check if anything is staged
    const status = await this.getStatus(projectId, signal);
    if (status.stagedCount === 0) {
      throw new GitServiceError("NOTHING_STAGED", "No changes staged to commit");
    }

    try {
      const commitRes = await this._cli.exec(root, ["commit", "-m", cleanMsg], { signal });

      if (commitRes.exitCode !== 0) {
        throw new GitServiceError("COMMIT_FAILED", `git commit failed: ${commitRes.stderr}`);
      }

      // Extract created commit SHA
      const headRes = await this._cli.exec(root, ["rev-parse", "HEAD"], { signal });
      const commitSha = headRes.exitCode === 0 ? headRes.stdout.trim() : undefined;

      return {
        success: true,
        message: `Created commit ${commitSha?.slice(0, 7) ?? ""}`,
        commitSha,
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof GitServiceError && err.gitCode === "CANCELLED")) {
        throw new GitServiceError("CANCELLED", "Git commit was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }

  async discard(
    projectId: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitOperationResult> {
    const root = this._requireWorkspace(projectId);
    const repoInfo = await this.detectRepository(projectId, signal);

    if (!repoInfo.isRepo) {
      throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
    }

    const validatedPaths = this._validatePaths(root, paths);

    try {
      // 1. Unstage any staged changes first
      await this.unstage(projectId, validatedPaths, signal).catch(() => undefined);

      // 2. Discard working tree changes via restore
      const restoreRes = await this._cli.exec(root, ["restore", "--", ...validatedPaths], {
        signal,
      });

      // 3. For any untracked files in the list, delete them safely
      for (const p of validatedPaths) {
        const fullPath = path.resolve(root, p);
        if (fs.existsSync(fullPath)) {
          const stat = fs.lstatSync(fullPath);
          // Directory guard: only files/symlinks may be removed — never directories.
          if (stat.isFile() || stat.isSymbolicLink()) {
            // Check status to ensure it's untracked
            const checkUntracked = await this._cli.exec(
              root,
              ["status", "--porcelain=v1", "--", p],
              { signal },
            );
            if (checkUntracked.stdout.trim().startsWith("??")) {
              fs.unlinkSync(fullPath);
            }
          }
        }
      }

      if (restoreRes.exitCode !== 0) {
        throw new GitServiceError("DISCARD_FAILED", `git restore failed: ${restoreRes.stderr}`);
      }

      return {
        success: true,
        message: `Discarded changes in ${validatedPaths.length} path(s)`,
        affectedPaths: validatedPaths,
      };
    } catch (err) {
      if (signal?.aborted || (err instanceof GitServiceError && err.gitCode === "CANCELLED")) {
        throw new GitServiceError("CANCELLED", "Git discard was cancelled");
      }
      const canonical = toCanonicalGitError(err);
      throw new GitServiceError(canonical.code as never, canonical.message);
    }
  }
}
