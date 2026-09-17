// PR42: apps/desktop — Git IPC Module (thin handlers, no new service)
//
// Thin handlers over GitService. Mirrors the workspace:* handler pattern in
// main/ipc/index.ts: no PermissionManager call in IPC (agent tools enforce
// permissions via GitToolExecutor); Zod schemas in @ai-desktop/shared
// validate before any handler runs.
//
// Security posture:
//   - Every operation is project-scoped through the GitService workspace
//     root resolver; the renderer never receives absolute main-side paths.
//   - GitServiceError codes are preserved as "CODE: message" strings (same
//     convention as the workspace IPC handlers) so the renderer can branch
//     on failure kinds from the envelope message.
//   - AbortError maps to "CANCELLED: Git operation was cancelled".
//   - There is intentionally NO git:execute channel — execution flows
//     through the agent tool router, never through IPC.

import type {
  GitBranchesCommand,
  GitCommitCommand,
  GitDetectCommand,
  GitDiffCommand,
  GitLogCommand,
  GitStageCommand,
  GitStatusCommand,
  GitUnstageCommand,
} from "@ai-desktop/shared";
import { GitServiceError } from "./git-errors.js";
import type { GitService } from "./git-service.js";

export interface GitIpcDependencies {
  readonly gitService: GitService;
}

function rethrowGit(err: unknown): never {
  if (err instanceof GitServiceError) {
    throw new Error(`${err.gitCode}: ${err.message}`);
  }
  if (err instanceof Error && err.name === "AbortError") {
    throw new Error("CANCELLED: Git operation was cancelled");
  }
  throw err;
}

export async function detectGitRepository(
  deps: GitIpcDependencies,
  input: GitDetectCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.detectRepository(input.projectId);
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function getGitStatus(
  deps: GitIpcDependencies,
  input: GitStatusCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.getStatus(input.projectId);
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function getGitDiff(
  deps: GitIpcDependencies,
  input: GitDiffCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.getDiff(input.projectId, {
      staged: input.staged ?? false,
      ...(input.path !== undefined ? { path: input.path } : {}),
    });
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function getGitLog(
  deps: GitIpcDependencies,
  input: GitLogCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.getLog(input.projectId, {
      limit: input.limit ?? 20,
    });
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function getGitBranches(
  deps: GitIpcDependencies,
  input: GitBranchesCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.getBranches(input.projectId);
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function stageGitPaths(
  deps: GitIpcDependencies,
  input: GitStageCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.stage(input.projectId, [...input.paths]);
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function unstageGitPaths(
  deps: GitIpcDependencies,
  input: GitUnstageCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.unstage(input.projectId, [...input.paths]);
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}

export async function commitGitStaged(
  deps: GitIpcDependencies,
  input: GitCommitCommand,
): Promise<{ result: unknown }> {
  try {
    const result = await deps.gitService.commit(input.projectId, input.message);
    return { result };
  } catch (err: unknown) {
    rethrowGit(err);
  }
}
