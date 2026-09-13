// PR30.7/30.8: apps/desktop — Coding Tool Executor + Permission Tests

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolCallId } from "@ai-desktop/shared";
import { now } from "@ai-desktop/shared";
import { createExecutionId } from "@ai-desktop/ai-core";
import type { PermissionCheck, PermissionDecisionResult } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { ExecutionManager, ExecutionRequest, ExecutionResult } from "@ai-desktop/ai-core";
import {
  buildAllCodingToolDefinitions,
  CodingToolExecutor,
  computeCodingToolHash,
} from "../coding-tools.js";

class AllowAllPermissions implements PermissionManager {
  readonly checks: string[] = [];
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(`${request.capability}:${request.action}:${request.resource}`);
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

class DenyAllPermissions implements PermissionManager {
  async check(): Promise<PermissionDecisionResult> {
    return { kind: "deny", reason: "Denied in test" };
  }
  async resolve(): Promise<boolean> {
    return false;
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

class StubExecutionManager implements ExecutionManager {
  readonly requests: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  constructor(private readonly _exitCode = 0) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push({
      command: request.command,
      args: request.args,
      ...(request.workingDirectory ? { cwd: request.workingDirectory } : {}),
    });
    return {
      executionId: createExecutionId(),
      exitCode: this._exitCode,
      stdout: "stub-output",
      stderr: "",
      durationMs: 5,
      timedOut: false,
      timestamp: now(),
    };
  }
  async createSession(): Promise<never> {
    throw new Error("unused");
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async destroySession(): Promise<void> {}
  get sandboxProvider(): never {
    throw new Error("unused");
  }
}

let root: string;
let permissions: AllowAllPermissions;
let execution: StubExecutionManager;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-exec-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
  permissions = new AllowAllPermissions();
  execution = new StubExecutionManager();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function createExecutor(pm: PermissionManager = permissions, em: ExecutionManager = execution) {
  return new CodingToolExecutor({
    permissionManager: pm,
    executionManager: em,
    resolveWorkspace: (projectId?: string) => (projectId === "proj-A" ? root : undefined),
  });
}

describe("apps/desktop: Coding tool executor (PR30.7–30.8)", () => {
  it("registers five canonical builtin definitions with stable hashes", () => {
    const defs = buildAllCodingToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual([
      "builtin:filesystem.list",
      "builtin:filesystem.search",
      "builtin:filesystem.read",
      "builtin:filesystem.write",
      "builtin:execution.run",
    ]);
    for (const def of defs) {
      expect(def.source).toBe("builtin");
      expect(def.metadata?.definitionHash).toBe(
        computeCodingToolHash({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          runtime: def.runtime,
        }),
      );
    }
    // Mutation changes the hash (trust/invalidation model).
    const mutated = computeCodingToolHash({
      name: defs[0].name,
      description: `${defs[0].description} tampered`,
      parameters: defs[0].parameters,
      runtime: defs[0].runtime,
    });
    expect(mutated).not.toBe(defs[0].metadata?.definitionHash);
  });

  it("executes read through validate -> permission -> backend", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "builtin:filesystem.read",
      { path: "src/a.ts" },
      { toolCallId: createToolCallId(), projectId: "proj-A" },
    );
    expect(result.isError).toBe(false);
    expect(result.result).toContain("const a = 1;");
    expect(permissions.checks.some((c) => c.startsWith("filesystem.read:read:"))).toBe(true);
  });

  it("rejects malformed input before permission or backend", async () => {
    const executor = createExecutor();
    await expect(
      executor.execute(
        "builtin:filesystem.read",
        {},
        { toolCallId: createToolCallId(), projectId: "proj-A" },
      ),
    ).rejects.toThrow(/Missing required parameter/);
    expect(permissions.checks).toHaveLength(0);
  });

  it("denied tools never reach the backend", async () => {
    const executor = createExecutor(new DenyAllPermissions());
    const result = await executor.execute(
      "builtin:filesystem.write",
      { path: "src/a.ts", content: "evil" },
      { toolCallId: createToolCallId(), projectId: "proj-A" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.result)).toContain("Permission denied");
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("fails closed for unregistered project workspaces", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "builtin:filesystem.read",
      { path: "src/a.ts" },
      { toolCallId: createToolCallId(), projectId: "proj-UNKNOWN" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.result)).toContain("No workspace");
  });

  it("routes command execution through ExecutionManager with contained cwd", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "builtin:execution.run",
      { command: "node", args: ["--version"], cwd: "src" },
      { toolCallId: createToolCallId(), projectId: "proj-A" },
    );
    expect(execution.requests).toHaveLength(1);
    expect(execution.requests[0].command).toBe("node");
    expect(execution.requests[0].cwd).toBe(path.join(root, "src"));
    expect(permissions.checks.some((c) => c.startsWith("execution.run:execute:"))).toBe(true);
    void result;
  });

  it("rejects execution cwd escaping the workspace", async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      "builtin:execution.run",
      { command: "node", cwd: "../outside" },
      { toolCallId: createToolCallId(), projectId: "proj-A" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.result)).toContain("Invalid working directory");
    expect(execution.requests).toHaveLength(0);
  });

  it("rejects unknown tool ids", async () => {
    const executor = createExecutor();
    await expect(
      executor.execute("builtin:filesystem.destroy", {}, { toolCallId: createToolCallId() }),
    ).rejects.toThrow(/Unknown coding tool/);
  });
});
