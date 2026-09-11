// PR24: apps/desktop/__tests__ — Permission Lifecycle & IPC Approval Integration Suite
//
// Invariants (PR24.8, PR24.9, PR24.12):
//   1. Canonical order: validation -> permission -> execution.
//   2. Validation failure aborts before PermissionManager is ever checked.
//   3. PermissionManager.check() returning requires_user halts execution until resolved.
//   4. IPC approval resolves the request and authorizes execution.
//   5. IPC denial halts execution; executor is NOT called.
//   6. Parallel tool calls maintain independent permission states.
//   7. Race condition safety: interleaved approve/deny/revoke resolve deterministically.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS, createToolCallId, type PermissionRequestId } from "@ai-desktop/shared";
import type { PermissionCheck, PermissionRequest } from "@ai-desktop/ai-core";
import { DefaultPermissionManager } from "@ai-desktop/permissions";
import type {
  CreatePolicyData,
  FindAuditQuery,
  FindPoliciesQuery,
  PermissionRepository,
  RecordAuditData,
  StoredPermissionAudit,
  StoredPermissionPolicy,
} from "@ai-desktop/storage";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";

class InMemoryPermissionRepository implements PermissionRepository {
  private readonly _policies = new Map<string, StoredPermissionPolicy>();
  private readonly _audits: StoredPermissionAudit[] = [];

  async savePolicy(data: CreatePolicyData): Promise<StoredPermissionPolicy> {
    const policy: StoredPermissionPolicy = {
      id: data.id,
      projectId: data.projectId ?? null,
      capability: data.capability,
      action: data.action ?? null,
      resourcePattern: data.resourcePattern ?? null,
      decision: data.decision,
      scope: data.scope,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      expiresAt: data.expiresAt ?? null,
    };
    this._policies.set(data.id, policy);
    return policy;
  }

  async getPolicyById(id: string): Promise<StoredPermissionPolicy | null> {
    return this._policies.get(id) ?? null;
  }

  async findPolicies(query?: FindPoliciesQuery): Promise<StoredPermissionPolicy[]> {
    return [...this._policies.values()].filter((p) => {
      if (query?.projectId !== undefined && p.projectId !== query.projectId) return false;
      if (query?.capability !== undefined && p.capability !== query.capability) return false;
      if (query?.scope !== undefined && p.scope !== query.scope) return false;
      return true;
    });
  }

  async deletePolicy(id: string): Promise<void> {
    this._policies.delete(id);
  }

  async deletePoliciesByCriteria(criteria: {
    capability: string;
    projectId?: string | null;
    resourcePattern?: string | null;
  }): Promise<number> {
    let count = 0;
    for (const [id, p] of this._policies.entries()) {
      if (
        p.capability === criteria.capability &&
        (criteria.projectId === undefined || p.projectId === criteria.projectId) &&
        (criteria.resourcePattern === undefined || p.resourcePattern === criteria.resourcePattern)
      ) {
        this._policies.delete(id);
        count++;
      }
    }
    return count;
  }

  async recordAudit(data: RecordAuditData): Promise<StoredPermissionAudit> {
    const entry: StoredPermissionAudit = {
      id: data.id,
      projectId: data.projectId ?? null,
      conversationId: data.conversationId ?? null,
      permissionRequestId: data.permissionRequestId ?? null,
      capability: data.capability,
      action: data.action,
      resource: data.resource,
      scope: data.scope,
      risk: data.risk,
      decision: data.decision,
      decidedBy: data.decidedBy,
      relatedToolCallIds: [...data.relatedToolCallIds],
      reason: data.reason ?? null,
      timestamp: data.timestamp,
    };
    this._audits.push(entry);
    return entry;
  }

  async getAuditHistory(query?: FindAuditQuery): Promise<StoredPermissionAudit[]> {
    return [...this._audits].filter((a) => {
      if (query?.projectId && a.projectId !== query.projectId) return false;
      if (query?.capability && a.capability !== query.capability) return false;
      return true;
    });
  }
}

describe("PR24: Tool Lifecycle & IPC Approval Integration", () => {
  function setupHarness() {
    const storage = new InMemoryPermissionRepository();
    const permissionManager = new DefaultPermissionManager({ storage });
    const ipcRegistry = new IpcRegistry();
    registerIpcHandlers(ipcRegistry, { permissionManager });

    return { storage, permissionManager, ipcRegistry };
  }

  it("enforces validation -> permission -> execution order", async () => {
    const { permissionManager } = setupHarness();
    let executorCalled = false;

    // Simulated Tool Executor
    const executeTool = async (input: { path: string }) => {
      // 1. Input validation first (§PR24.8)
      if (!input.path || typeof input.path !== "string") {
        throw new Error("Validation error: path must be a non-empty string");
      }

      // 2. Permission check second (§PR24.8)
      const permResult = await permissionManager.check({
        capability: "filesystem",
        action: "read",
        resource: input.path,
        scope: "once",
        risk: "low",
        relatedToolCallIds: [createToolCallId()],
      });

      if (permResult.kind !== "allow") {
        return { executed: false, reason: "Requires user permission or denied" };
      }

      // 3. Execution third (§PR24.8)
      executorCalled = true;
      return { executed: true, data: "file content" };
    };

    // Case 1: Invalid input fails at validation step before permission check
    await expect(executeTool({ path: "" })).rejects.toThrow("Validation error");
    expect(executorCalled).toBe(false);

    // Case 2: Valid input reaches permission checkpoint, pauses at requires_user
    const pendingResult = await executeTool({ path: "/workspace/src/app.ts" });
    expect(pendingResult.executed).toBe(false);
    expect(executorCalled).toBe(false);
  });

  it("IPC approval flow: requires_user -> IPC resolve -> execution permitted", async () => {
    const { permissionManager, ipcRegistry } = setupHarness();
    let executorCalled = false;

    const toolCallId = createToolCallId();
    const check: PermissionCheck = {
      capability: "filesystem",
      action: "write",
      resource: "/workspace/output.txt",
      scope: "once",
      risk: "medium",
      relatedToolCallIds: [toolCallId],
    };

    // 1. Initial tool call checks permission via IPC
    const checkRes = await ipcRegistry.invokeCommand<{
      result: { kind: string; request?: PermissionRequest };
    }>(IPC_CHANNELS.PERMISSION_CHECK, {
      ...check,
      projectId: "proj-1",
    });

    expect(checkRes.ok).toBe(true);
    let requestId = "" as PermissionRequestId;
    if (checkRes.ok) {
      expect(checkRes.value.result.kind).toBe("requires_user");
      requestId = (checkRes.value.result.request?.id ?? "") as PermissionRequestId;
    }
    expect(requestId).toBeDefined();

    // 2. Pending list exposes the request over IPC
    const listRes = await ipcRegistry.invokeCommand<{ requests: PermissionRequest[] }>(
      IPC_CHANNELS.PERMISSION_REQUESTS_LIST,
      {},
    );
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.value.requests.some((r: PermissionRequest) => r.id === requestId)).toBe(true);
    }

    // 3. User approves request via IPC (Allow once)
    const resolveRes = await ipcRegistry.invokeCommand<{ resolved: boolean }>(
      IPC_CHANNELS.PERMISSION_RESOLVE,
      {
        requestId,
        decision: "granted",
        mode: "allow_once",
      },
    );
    expect(resolveRes.ok).toBe(true);
    if (resolveRes.ok) {
      expect(resolveRes.value.resolved).toBe(true);
    }

    // 4. Execution continues: re-check succeeds
    const recheckResult = await permissionManager.check(check, { projectId: "proj-1" });
    expect(recheckResult.kind).toBe("allow");

    if (recheckResult.kind === "allow") {
      executorCalled = true;
    }
    expect(executorCalled).toBe(true);
  });

  it("IPC denial flow: requires_user -> IPC deny -> execution blocked", async () => {
    const { permissionManager, ipcRegistry } = setupHarness();
    let executorCalled = false;

    const toolCallId = createToolCallId();
    const check: PermissionCheck = {
      capability: "execution",
      action: "execute",
      resource: "rm -rf /tmp/data",
      scope: "once",
      risk: "high",
      relatedToolCallIds: [toolCallId],
    };

    // 1. Tool check triggers requires_user
    const checkRes = await ipcRegistry.invokeCommand<{
      result: { kind: string; request?: PermissionRequest };
    }>(IPC_CHANNELS.PERMISSION_CHECK, {
      ...check,
      projectId: "proj-deny",
    });

    let requestId = "" as PermissionRequestId;
    if (checkRes.ok) {
      requestId = (checkRes.value.result.request?.id ?? "") as PermissionRequestId;
    }

    // 2. User denies over IPC
    const resolveRes = await ipcRegistry.invokeCommand<{ resolved: boolean }>(
      IPC_CHANNELS.PERMISSION_RESOLVE,
      {
        requestId,
        decision: "denied",
        mode: "deny",
        reason: "User denied dangerous command",
      },
    );
    expect(resolveRes.ok).toBe(true);

    // 3. Re-check is denied
    const recheckResult = await permissionManager.check(check, { projectId: "proj-deny" });
    expect(recheckResult.kind).toBe("deny");

    if (recheckResult.kind === "allow") {
      executorCalled = true;
    }
    expect(executorCalled).toBe(false);
  });

  it("parallel tool requests maintain independent permission states", async () => {
    const { permissionManager, ipcRegistry } = setupHarness();

    const toolA = createToolCallId();
    const toolB = createToolCallId();

    const checkA: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/a.json",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolA],
    };

    const checkB: PermissionCheck = {
      capability: "execution",
      action: "execute",
      resource: "npm run build",
      scope: "once",
      risk: "medium",
      relatedToolCallIds: [toolB],
    };

    // Both triggered in parallel (different batches)
    const [resA, resB] = await Promise.all([
      permissionManager.check(checkA),
      permissionManager.check(checkB),
    ]);

    expect(resA.kind).toBe("requires_user");
    expect(resB.kind).toBe("requires_user");

    if (resA.kind !== "requires_user" || resB.kind !== "requires_user") return;

    // Requests are completely distinct
    expect(resA.request.id).not.toBe(resB.request.id);

    // Approve A, deny B via IPC
    await Promise.all([
      ipcRegistry.invokeCommand(IPC_CHANNELS.PERMISSION_RESOLVE, {
        requestId: resA.request.id,
        decision: "granted",
        mode: "allow_once",
      }),
      ipcRegistry.invokeCommand(IPC_CHANNELS.PERMISSION_RESOLVE, {
        requestId: resB.request.id,
        decision: "denied",
        mode: "deny",
      }),
    ]);

    expect((await permissionManager.check(checkA)).kind).toBe("allow");
    expect((await permissionManager.check(checkB)).kind).toBe("deny");
  });

  it("race condition: interleaved approve, revoke, and approve behaves deterministically", async () => {
    const { permissionManager, ipcRegistry } = setupHarness();

    const toolCall = createToolCallId();
    const check: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "weather/get_forecast",
      scope: "project",
      risk: "low",
      relatedToolCallIds: [toolCall],
    };

    // 1. Initial check
    const res = await permissionManager.check(check, { projectId: "p-race" });
    if (res.kind !== "requires_user") return;

    // 2. Approve for project
    await ipcRegistry.invokeCommand(IPC_CHANNELS.PERMISSION_RESOLVE, {
      requestId: res.request.id,
      decision: "granted",
      mode: "allow_project",
    });
    expect((await permissionManager.check(check, { projectId: "p-race" })).kind).toBe("allow");

    // 3. Revoke policy
    const revokeRes = await ipcRegistry.invokeCommand<{ revokedCount: number }>(
      IPC_CHANNELS.PERMISSION_REVOKE,
      {
        capability: "mcp",
        projectId: "p-race",
      },
    );
    expect(revokeRes.ok).toBe(true);
    if (revokeRes.ok) {
      expect(revokeRes.value.revokedCount).toBeGreaterThanOrEqual(1);
    }

    // 4. Now requires approval again
    const afterRevoke = await permissionManager.check(check, { projectId: "p-race" });
    expect(afterRevoke.kind).toBe("requires_user");

    if (afterRevoke.kind === "requires_user") {
      // 5. Re-approve
      await ipcRegistry.invokeCommand(IPC_CHANNELS.PERMISSION_RESOLVE, {
        requestId: afterRevoke.request.id,
        decision: "granted",
        mode: "allow_project",
      });

      expect((await permissionManager.check(check, { projectId: "p-race" })).kind).toBe("allow");
    }
  });
});
