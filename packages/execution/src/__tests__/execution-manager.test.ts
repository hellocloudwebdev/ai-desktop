import { describe, expect, it } from "vitest";
import {
  createExecutionId,
  type ExecutionRequest,
  type ExecutionResult,
  type PermissionCheck,
  type PermissionDecisionResult,
  type PermissionManager,
  type SessionId,
} from "@ai-desktop/ai-core";
import { now, ValidationError } from "@ai-desktop/shared";
import { DefaultExecutionManager } from "../core/default-execution-manager.js";
import type { SandboxProvider } from "../core/sandbox-provider.js";
import type { CreateSessionOptions, Session } from "../core/session.js";

class MockSandboxProvider implements SandboxProvider {
  readonly name = "mock";
  readonly executions: ExecutionRequest[] = [];
  private readonly _sessions = new Map<SessionId, Session>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const session: Session = {
      id: "sess-1" as unknown as SessionId,
      projectId: options.projectId,
      workspacePath: options.workspacePath,
      workingDirectory: options.workingDirectory ?? "/workspace",
      environment: { ...(options.environment ?? {}) },
      readOnlyWorkspace: options.readOnlyWorkspace ?? true,
      networkAllowed: options.networkAllowed ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._sessions.set(session.id, session);
    return session;
  }

  async execute(_session: Session, request: ExecutionRequest): Promise<ExecutionResult> {
    this.executions.push(request);
    return {
      executionId: request.id,
      exitCode: 0,
      stdout: "Mock stdout",
      stderr: "",
      durationMs: 10,
      timedOut: false,
      timestamp: now(),
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  async destroySession(sessionId: SessionId): Promise<void> {
    this._sessions.delete(sessionId);
  }

  listActiveSessions(): readonly Session[] {
    return [...this._sessions.values()];
  }
}

class MockPermissionManager implements PermissionManager {
  public decision: PermissionDecisionResult = { kind: "allow" };
  readonly checks: PermissionCheck[] = [];

  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return this.decision;
  }
}

describe("packages/execution: DefaultExecutionManager & Permission Lifecycle (PR27.6, PR27.13)", () => {
  it("enforces canonical order: validation failure aborts before PermissionManager is invoked", async () => {
    const sandboxProvider = new MockSandboxProvider();
    const permissionManager = new MockPermissionManager();
    const manager = new DefaultExecutionManager({
      sandboxProvider,
      permissionManager,
    });

    const invalidRequest = {
      id: "not-a-valid-ulid",
      command: "",
    } as unknown as ExecutionRequest;

    await expect(manager.execute(invalidRequest)).rejects.toThrow(ValidationError);

    // PermissionManager must NOT be checked on invalid input
    expect(permissionManager.checks).toHaveLength(0);
    expect(sandboxProvider.executions).toHaveLength(0);
  });

  it("checks command- and cwd-aware permissions before execution (§PR27.13)", async () => {
    const sandboxProvider = new MockSandboxProvider();
    const permissionManager = new MockPermissionManager();
    const manager = new DefaultExecutionManager({
      sandboxProvider,
      permissionManager,
    });

    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "npm test",
      args: ["--", "unit"],
      workingDirectory: "/workspace/proj",
      timestamp: now(),
    };

    const res = await manager.execute(request);
    expect(res.exitCode).toBe(0);

    // Verify PermissionManager check contained command and cwd metadata
    expect(permissionManager.checks).toHaveLength(1);
    const check = permissionManager.checks[0];
    expect(check.capability).toBe("execution");
    expect(check.action).toBe("execute");
    expect(check.resource).toBe("npm test");
    expect(check.metadata?.cwd).toBe("/workspace/proj");
    expect(check.metadata?.command).toBe("npm test");
  });

  it("permission denial stops execution before SandboxProvider is invoked", async () => {
    const sandboxProvider = new MockSandboxProvider();
    const permissionManager = new MockPermissionManager();
    permissionManager.decision = { kind: "deny", reason: "Execution of rm -rf / is denied" };

    const manager = new DefaultExecutionManager({
      sandboxProvider,
      permissionManager,
    });

    const request: ExecutionRequest = {
      id: createExecutionId(),
      mode: "sandboxed",
      command: "rm -rf /",
      args: [],
      timestamp: now(),
    };

    const res = await manager.execute(request);
    expect(res.exitCode).toBe(126);
    expect(res.stderr).toContain("Permission denied: Execution of rm -rf / is denied");

    // SandboxProvider was NEVER invoked!
    expect(sandboxProvider.executions).toHaveLength(0);
  });

  it("delegates cancellation cleanly to SandboxProvider", async () => {
    const sandboxProvider = new MockSandboxProvider();
    const manager = new DefaultExecutionManager({
      sandboxProvider,
    });

    const execId = createExecutionId();
    expect(await manager.cancel(execId)).toBe(true);
  });
});
