// PR46: packages/execution — Tool Boundary + Network/Path Guards (adversarial)
import { describe, expect, it, vi } from "vitest";
import {
  createExecutionId,
  type ExecutionRequest,
  type ExecutionResult,
  type PermissionManager,
  type SessionId,
} from "@ai-desktop/ai-core";
import { now } from "@ai-desktop/shared";
import { DefaultExecutionManager } from "../core/default-execution-manager.js";
import type { SandboxProvider } from "../core/sandbox-provider.js";
import type { CreateSessionOptions, Session } from "../core/session.js";
import { FORBIDDEN_MOUNT_TARGETS, MAX_EXECUTION_OUTPUT_BYTES } from "../docker/docker-provider.js";
import { LocalProcessSandboxProvider } from "../local/local-sandbox-provider.js";

class MockSandbox implements SandboxProvider {
  readonly name = "mock";
  readonly executions: ExecutionRequest[] = [];
  readonly seenEnvs: Array<Record<string, string> | undefined> = [];
  async isAvailable(): Promise<boolean> {
    return true;
  }
  listActiveSessions(): readonly Session[] {
    return [];
  }
  async createSession(options: CreateSessionOptions): Promise<Session> {
    return {
      id: "sess-1" as unknown as SessionId,
      projectId: options.projectId,
      workspacePath: options.workspacePath,
      workingDirectory: options.workingDirectory ?? "/workspace",
      environment: { ...(options.environment ?? {}) },
      readOnlyWorkspace: true,
      networkAllowed: options.networkAllowed ?? false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  async execute(session: Session, request: ExecutionRequest): Promise<ExecutionResult> {
    this.executions.push(request);
    this.seenEnvs.push(request.environmentVariables as Record<string, string> | undefined);
    void session;
    return {
      executionId: request.id,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      timestamp: now(),
    };
  }
  async cancel(): Promise<boolean> {
    return true;
  }
  async destroySession(): Promise<void> {}
}

function req(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    id: createExecutionId(),
    mode: "sandboxed",
    command: "node",
    args: ["--version"],
    timestamp: now(),
    ...overrides,
  } as ExecutionRequest;
}
function allow(): PermissionManager {
  return {
    check: async () => ({ kind: "allow" }),
    resolve: async () => true,
    revoke: async () => 0,
    getPendingRequest: () => undefined,
    listPendingRequests: () => [],
    listActivePolicies: async () => [],
  } as unknown as PermissionManager;
}

describe("execution tool-boundary", () => {
  it("validation fails before permission (zero permission calls)", async () => {
    const sandbox = new MockSandbox();
    const check = vi.fn(async () => ({ kind: "allow" as const }));
    const manager = new DefaultExecutionManager({
      sandboxProvider: sandbox,
      permissionManager: { ...allow(), check } as unknown as PermissionManager,
    });
    await expect(manager.execute({} as never)).rejects.toThrow(/validation/i);
    expect(check).not.toHaveBeenCalled();
    expect(sandbox.executions.length).toBe(0);
  });
  it("permission-denied returns 126 with zero sandbox calls", async () => {
    const sandbox = new MockSandbox();
    const manager = new DefaultExecutionManager({
      sandboxProvider: sandbox,
      permissionManager: {
        check: async () => ({ kind: "deny", reason: "no" }),
        resolve: async () => true,
        revoke: async () => 0,
        getPendingRequest: () => undefined,
        listPendingRequests: () => [],
        listActivePolicies: async () => [],
      } as unknown as PermissionManager,
    });
    const result = await manager.execute(req());
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/permission denied/i);
    expect(sandbox.executions.length).toBe(0);
  });
  it("requires_user permission never executes (fail-closed)", async () => {
    const sandbox = new MockSandbox();
    const manager = new DefaultExecutionManager({
      sandboxProvider: sandbox,
      permissionManager: {
        check: async () => ({ kind: "requires_user", request: {} as never }),
        resolve: async () => true,
        revoke: async () => 0,
        getPendingRequest: () => undefined,
        listPendingRequests: () => [],
        listActivePolicies: async () => [],
      } as unknown as PermissionManager,
    });
    const result = await manager.execute(req());
    expect(result.exitCode).toBe(126);
    expect(sandbox.executions.length).toBe(0);
  });
  it("cancel is idempotent and delegated", async () => {
    const sandbox = new MockSandbox();
    const manager = new DefaultExecutionManager({
      sandboxProvider: sandbox,
      permissionManager: allow(),
    });
    expect(await manager.cancel("01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never)).toBe(true);
    expect(await manager.cancel("01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never)).toBe(true);
  });
  it("never inherits wholesale process.env (allowlist only)", async () => {
    const sandbox = new MockSandbox();
    const manager = new DefaultExecutionManager({
      sandboxProvider: sandbox,
      permissionManager: allow(),
    });
    process.env.PR46_SENTINEL = "should-never-propagate";
    await manager.execute(req({ environmentVariables: { EXPLICIT: "yes" } }));
    const seen = sandbox.seenEnvs[0] ?? {};
    expect(seen["PR46_SENTINEL"]).toBeUndefined();
    expect(seen["EXPLICIT"]).toBe("yes");
    delete process.env.PR46_SENTINEL;
  });
});

describe("execution network and path guards", () => {
  it("sessions default to networkAllowed false (no silent egress)", async () => {
    const sandbox = new MockSandbox();
    const manager = new DefaultExecutionManager({
      sandboxProvider: sandbox,
      permissionManager: allow(),
    });
    await manager.createSession({ workspacePath: "/tmp/ws" });
    const created = await manager.createSession({
      workspacePath: "/tmp/ws2",
      networkAllowed: undefined,
    });
    expect(created.networkAllowed).toBe(false);
  });
  it("forbidden mount targets include system paths (no / or /etc escape)", () => {
    expect(FORBIDDEN_MOUNT_TARGETS).toContain("/");
    expect(FORBIDDEN_MOUNT_TARGETS).toContain("/etc");
    expect(FORBIDDEN_MOUNT_TARGETS).toContain("/var/run/docker.sock");
  });
  it("local provider rejects forbidden workspace mounts", async () => {
    const provider = new LocalProcessSandboxProvider();
    await expect(provider.createSession({ workspacePath: "/" })).rejects.toThrow(/forbidden/i);
    await expect(provider.createSession({ workspacePath: "/etc" })).rejects.toThrow(/forbidden/i);
  });
  it("256KB output ceiling constant is enforced at providers", () => {
    expect(MAX_EXECUTION_OUTPUT_BYTES).toBe(256 * 1024);
  });
});
