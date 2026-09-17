// PR42: apps/desktop — Git Subsystem Unit Tests
//
// Tests GitCliClient parsers, GitService operations against isolated temporary
// repositories, path policy enforcement, and GitToolExecutor lifecycle.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PermissionCheck, PermissionDecisionResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import { ValidationError } from "@ai-desktop/shared";
import { GitCliClient } from "../git-cli.js";
import { GitService } from "../git-service.js";
import { GitToolExecutor } from "../git-tool-executor.js";
import { GitServiceError } from "../git-errors.js";

class AllowAllPermissions implements PermissionManager {
  readonly checks: PermissionCheck[] = [];

  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return { kind: "allow" };
  }

  async resolve(): Promise<boolean> {
    return true;
  }
  async revoke(): Promise<number> {
    return 0;
  }
  getPendingRequest(): undefined {
    return undefined;
  }
  listPendingRequests(): readonly [] {
    return [];
  }
  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

class DenyAllPermissions extends AllowAllPermissions {
  override async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return { kind: "deny", reason: "Git operation denied by test policy" };
  }
}

describe("GitCliClient output parsers", () => {
  const cli = new GitCliClient();

  it("parses porcelain v1 status with diverse file states", () => {
    // Porcelain v1: X = index (staged), Y = worktree (unstaged).
    const porcelain = [
      " M modified-staged.ts", // X=' ', Y='M' = unstaged only (despite filename)
      "M  modified-unstaged.ts", // X='M', Y=' ' = staged only (despite filename)
      "MM modified-both.ts", // X='M', Y='M' = both staged and unstaged
      "A  added-new.ts", // staged
      "D  deleted-file.ts", // X='D' staged deletion counts as staged
      "R  old-name.ts -> new-name.ts", // staged rename
      "?? untracked.ts",
      "UU conflicted.ts",
    ].join("\n");

    const result = cli.parseStatus(porcelain);
    expect(result.files).toHaveLength(8);
    expect(result.stagedCount).toBe(5); // M , MM, A, D, R (D staged counts as staged)
    expect(result.unstagedCount).toBe(2); // " M" and "MM"
    expect(result.untrackedCount).toBe(1); // ??
    expect(result.conflictedCount).toBe(1); // UU

    const renamed = result.files.find((f) => f.path === "new-name.ts");
    expect(renamed?.oldPath).toBe("old-name.ts");
    expect(renamed?.index).toBe("renamed");

    const conflicted = result.files.find((f) => f.path === "conflicted.ts");
    expect(conflicted?.conflicted).toBe(true);
  });

  it("parses unified diff output with hunks and additions/deletions", () => {
    const rawDiff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 context line 1
-deleted line
+added line 1
+added line 2
 context line 2
diff --git a/assets/image.png b/assets/image.png
index 3333333..4444444 100644
Binary files a/assets/image.png and b/assets/image.png differ
`;

    const diff = cli.parseDiff(rawDiff);
    expect(diff.files).toHaveLength(2);
    expect(diff.totalAdditions).toBe(2);
    expect(diff.totalDeletions).toBe(1);

    const appDiff = diff.files[0]!;
    expect(appDiff.path).toBe("src/app.ts");
    expect(appDiff.isBinary).toBe(false);
    expect(appDiff.hunks).toHaveLength(1);
    expect(appDiff.hunks[0]?.lines).toHaveLength(5);

    const binDiff = diff.files[1]!;
    expect(binDiff.path).toBe("assets/image.png");
    expect(binDiff.isBinary).toBe(true);
    expect(binDiff.hunks).toHaveLength(0);
  });

  it("parses delimiter-separated git log output", () => {
    const rawLog =
      "b489ad39956f571a23aaf0b6f301aee2af043c92\x1fb489ad3\x1fDev\x1fdev@test.com\x1f2026-09-17T12:00:00Z\x1fcommit summary\x1fcommit body paragraph\x1faa05da5\x1e";

    const commits = cli.parseLog(rawLog);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.sha).toBe("b489ad39956f571a23aaf0b6f301aee2af043c92");
    expect(commits[0]?.shortSha).toBe("b489ad3");
    expect(commits[0]?.author.name).toBe("Dev");
    expect(commits[0]?.author.email).toBe("dev@test.com");
    expect(commits[0]?.summary).toBe("commit summary");
    expect(commits[0]?.message).toBe("commit summary\n\ncommit body paragraph");
    expect(commits[0]?.parents).toEqual(["aa05da5"]);
  });

  it("parses branch output with ahead/behind tracking", () => {
    const rawBranch = [
      "* \x1fmain\x1fb489ad3\x1forigin/main\x1fahead 2, behind 1",
      "  \x1ffeature/test\x1faa05da5\x1f\x1f",
    ].join("\n");

    const { branches, currentBranch, detached } = cli.parseBranches(rawBranch);
    expect(branches).toHaveLength(2);
    expect(currentBranch).toBe("main");
    expect(detached).toBe(false);

    const mainBranch = branches.find((b) => b.name === "main");
    expect(mainBranch?.current).toBe(true);
    expect(mainBranch?.upstream).toBe("origin/main");
    expect(mainBranch?.ahead).toBe(2);
    expect(mainBranch?.behind).toBe(1);
  });
});

describe("GitService with temporary repositories", () => {
  let tempDir: string;
  let nonGitDir: string;
  let gitService: GitService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-service-test-"));
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-test-"));

    // Initialize temporary Git repository
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
      stdio: "ignore",
    });

    gitService = new GitService({
      resolveRoot: (projectId: string) => {
        if (projectId === "git-proj") return tempDir;
        if (projectId === "non-git-proj") return nonGitDir;
        return undefined;
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  });

  it("detects repository state and handles non-git projects cleanly", async () => {
    const gitRepo = await gitService.detectRepository("git-proj");
    expect(gitRepo.isRepo).toBe(true);
    expect(gitRepo.currentBranch).toBe("main");
    expect(gitRepo.empty).toBe(true);

    const nonRepo = await gitService.detectRepository("non-git-proj");
    expect(nonRepo.isRepo).toBe(false);

    const nonRepoStatus = await gitService.getStatus("non-git-proj");
    expect(nonRepoStatus.isRepo).toBe(false);
    expect(nonRepoStatus.clean).toBe(true);
  });

  it("fails closed when project workspace is not registered", async () => {
    await expect(gitService.getStatus("unknown-proj")).rejects.toThrowError(GitServiceError);
  });

  it("performs stage, commit, diff, and status end-to-end", async () => {
    // 1. Create a file
    const filePath = path.join(tempDir, "hello.txt");
    fs.writeFileSync(filePath, "Hello World\nLine 2\n", "utf8");

    // 2. Check initial status (untracked)
    let status = await gitService.getStatus("git-proj");
    expect(status.clean).toBe(false);
    expect(status.untrackedCount).toBe(1);

    // 3. Stage the file
    const stageRes = await gitService.stage("git-proj", ["hello.txt"]);
    expect(stageRes.success).toBe(true);

    status = await gitService.getStatus("git-proj");
    expect(status.stagedCount).toBe(1);
    expect(status.untrackedCount).toBe(0);

    // 4. Check staged diff
    const stagedDiff = await gitService.getDiff("git-proj", { staged: true });
    expect(stagedDiff.files).toHaveLength(1);
    expect(stagedDiff.totalAdditions).toBe(2);

    // 5. Commit
    const commitRes = await gitService.commit("git-proj", "Initial commit");
    expect(commitRes.success).toBe(true);
    expect(commitRes.commitSha).toBeDefined();

    status = await gitService.getStatus("git-proj");
    expect(status.clean).toBe(true);

    // 6. Check log
    const log = await gitService.getLog("git-proj");
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0]?.summary).toBe("Initial commit");

    // 7. Modify file and check unstaged diff
    fs.appendFileSync(filePath, "Line 3\n", "utf8");
    const unstagedDiff = await gitService.getDiff("git-proj", { staged: false });
    expect(unstagedDiff.files).toHaveLength(1);
    expect(unstagedDiff.totalAdditions).toBe(1);

    // 8. Stage and then unstage
    await gitService.stage("git-proj", ["hello.txt"]);
    status = await gitService.getStatus("git-proj");
    expect(status.stagedCount).toBe(1);

    await gitService.unstage("git-proj", ["hello.txt"]);
    status = await gitService.getStatus("git-proj");
    expect(status.stagedCount).toBe(0);
    expect(status.unstagedCount).toBe(1);

    // 9. Discard working tree changes
    const discardRes = await gitService.discard("git-proj", ["hello.txt"]);
    expect(discardRes.success).toBe(true);
    status = await gitService.getStatus("git-proj");
    expect(status.clean).toBe(true);
  });

  it("enforces path containment and rejects traversal attacks", async () => {
    await expect(gitService.stage("git-proj", ["../../etc/passwd"])).rejects.toThrowError(
      GitServiceError,
    );
    await expect(gitService.unstage("git-proj", ["/outside/abs/path"])).rejects.toThrowError(
      GitServiceError,
    );
  });

  it("rejects commit when nothing is staged or message is empty", async () => {
    await expect(gitService.commit("git-proj", "test")).rejects.toThrowError(
      /No changes staged to commit/,
    );
    await expect(gitService.commit("git-proj", "   ")).rejects.toThrowError(
      /Commit message cannot be empty/,
    );
  });
});

describe("GitToolExecutor lifecycle and permissions", () => {
  let tempDir: string;
  let gitService: GitService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-executor-test-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
      stdio: "ignore",
    });

    gitService = new GitService({
      resolveRoot: (projectId: string) => (projectId === "test-proj" ? tempDir : undefined),
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers all 7 canonical git tools", () => {
    const permissions = new AllowAllPermissions();
    const executor = new GitToolExecutor({ permissionManager: permissions, gitService });
    const tools = executor.listTools();
    expect(tools).toHaveLength(7);
    expect(executor.hasTool("builtin:git.status")).toBe(true);
    expect(executor.hasTool("builtin:git.diff")).toBe(true);
    expect(executor.hasTool("builtin:git.log")).toBe(true);
    expect(executor.hasTool("builtin:git.branches")).toBe(true);
    expect(executor.hasTool("builtin:git.stage")).toBe(true);
    expect(executor.hasTool("builtin:git.unstage")).toBe(true);
    expect(executor.hasTool("builtin:git.commit")).toBe(true);
  });

  it("validates input schema before checking permissions", async () => {
    const permissions = new AllowAllPermissions();
    const executor = new GitToolExecutor({ permissionManager: permissions, gitService });

    // Missing required 'paths' field on stage
    await expect(executor.execute("builtin:git.stage", { projectId: "test-proj" })).rejects.toThrow(
      ValidationError,
    );

    // Permission check was never invoked because validation failed first
    expect(permissions.checks).toHaveLength(0);
  });

  it("enforces PermissionManager denial and returns error ToolResult", async () => {
    const permissions = new DenyAllPermissions();
    const executor = new GitToolExecutor({ permissionManager: permissions, gitService });

    const result = await executor.execute("builtin:git.status", { projectId: "test-proj" });
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Permission denied: Git operation denied by test policy");
    expect(result.metadata?.["permissionStatus"]).toBe("deny");
    expect(permissions.checks).toHaveLength(1);
    expect(permissions.checks[0]?.capability).toBe("git");
    expect(permissions.checks[0]?.action).toBe("status");
  });

  it("executes successfully when permission is allowed", async () => {
    const permissions = new AllowAllPermissions();
    const executor = new GitToolExecutor({ permissionManager: permissions, gitService });

    const result = await executor.execute("builtin:git.status", { projectId: "test-proj" });
    expect(result.isError).toBe(false);
    expect(typeof result.result).toBe("string");
    const parsed = JSON.parse(result.result as string) as { isRepo: boolean; clean: boolean };
    expect(parsed.isRepo).toBe(true);
    expect(parsed.clean).toBe(true);
  });
});
