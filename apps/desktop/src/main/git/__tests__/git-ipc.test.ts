// PR42: apps/desktop — Git IPC Dispatch Tests
//
// Channels validate in main before handlers run; missing git deps fail
// closed; there is no execute channel anywhere on the contract; service
// errors surface as "CODE: message"; AbortError maps to CANCELLED; and
// dispatch reaches the GitService end to end (stubbed, no git binary).

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../../ipc/index.js";
import { GitServiceError } from "../git-errors.js";
import type { GitService } from "../git-service.js";
import type { GitIpcDependencies } from "../git-ipc.js";

function makeStubGitService(overrides?: Partial<Record<string, () => unknown>>): GitService {
  const stub = {
    detectRepository: async () => ({ isRepo: true, detached: false, empty: false }),
    getStatus: async () => ({ isRepo: true, clean: true, files: [] }),
    getDiff: async () => ({ files: [] }),
    getLog: async () => ({ commits: [], total: 0 }),
    getBranches: async () => ({ branches: [], detached: false }),
    stage: async () => ({ success: true }),
    unstage: async () => ({ success: true }),
    commit: async () => ({ success: true }),
    ...overrides,
  };
  return stub as unknown as GitService;
}

function makeDeps(service: GitService): GitIpcDependencies {
  return { gitService: service };
}

describe("apps/desktop: git IPC dispatch (PR42)", () => {
  it("declares the eight git channels with exact names", () => {
    expect(IPC_CHANNELS.GIT_DETECT).toBe("git:detect");
    expect(IPC_CHANNELS.GIT_STATUS).toBe("git:status");
    expect(IPC_CHANNELS.GIT_DIFF).toBe("git:diff");
    expect(IPC_CHANNELS.GIT_LOG).toBe("git:log");
    expect(IPC_CHANNELS.GIT_BRANCHES).toBe("git:branches");
    expect(IPC_CHANNELS.GIT_STAGE).toBe("git:stage");
    expect(IPC_CHANNELS.GIT_UNSTAGE).toBe("git:unstage");
    expect(IPC_CHANNELS.GIT_COMMIT).toBe("git:commit");
  });

  it("exposes no git:execute channel on the contract", () => {
    const values = Object.values(IPC_CHANNELS) as string[];
    expect(values).not.toContain("git:execute");
    expect(values.filter((c) => c.startsWith("git:"))).toHaveLength(8);
  });

  it("fails closed when git deps are missing", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {} });
    const res = await registry.invokeCommand(IPC_CHANNELS.GIT_STATUS, {
      projectId: "proj-1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe("GitService is not available");
    }
  });

  it("rejects malformed input before any handler runs", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, gitDeps: makeDeps(makeStubGitService()) });
    const res = await registry.invokeCommand(IPC_CHANNELS.GIT_STATUS, { projectId: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("dispatches detect -> status -> diff -> log -> branches end to end", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, gitDeps: makeDeps(makeStubGitService()) });

    for (const [channel, payload] of [
      [IPC_CHANNELS.GIT_DETECT, { projectId: "proj-1" }],
      [IPC_CHANNELS.GIT_STATUS, { projectId: "proj-1" }],
      [IPC_CHANNELS.GIT_DIFF, { projectId: "proj-1", staged: true }],
      [IPC_CHANNELS.GIT_LOG, { projectId: "proj-1", limit: 5 }],
      [IPC_CHANNELS.GIT_BRANCHES, { projectId: "proj-1" }],
    ] as const) {
      const res = await registry.invokeCommand<{ result: unknown }>(channel, payload);
      expect(res.ok).toBe(true);
    }
  });

  it("dispatches stage -> unstage -> commit end to end", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, gitDeps: makeDeps(makeStubGitService()) });

    const staged = await registry.invokeCommand<{ result: unknown }>(IPC_CHANNELS.GIT_STAGE, {
      projectId: "proj-1",
      paths: ["a.txt"],
    });
    expect(staged.ok).toBe(true);

    const unstaged = await registry.invokeCommand<{ result: unknown }>(IPC_CHANNELS.GIT_UNSTAGE, {
      projectId: "proj-1",
      paths: ["a.txt"],
    });
    expect(unstaged.ok).toBe(true);

    const committed = await registry.invokeCommand<{ result: unknown }>(IPC_CHANNELS.GIT_COMMIT, {
      projectId: "proj-1",
      message: "test commit",
    });
    expect(committed.ok).toBe(true);
  });

  it("preserves GitServiceError codes as CODE: message", async () => {
    const service = makeStubGitService({
      getStatus: async () => {
        throw new GitServiceError("NOT_A_REPO", "Project workspace is not a Git repository");
      },
    });
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, gitDeps: makeDeps(service) });
    const res = await registry.invokeCommand(IPC_CHANNELS.GIT_STATUS, { projectId: "proj-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe("NOT_A_REPO: Project workspace is not a Git repository");
    }
  });

  it("maps AbortError to CANCELLED", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const service = makeStubGitService({
      getDiff: async () => {
        throw abort;
      },
    });
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { callbacks: {}, gitDeps: makeDeps(service) });
    const res = await registry.invokeCommand(IPC_CHANNELS.GIT_DIFF, { projectId: "proj-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe("CANCELLED: Git operation was cancelled");
    }
  });
});
