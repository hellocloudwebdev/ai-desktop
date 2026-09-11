import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import type { AIEvent, PermissionCheck } from "@ai-desktop/ai-core";
import { DefaultPermissionManager } from "../core/default-permission-manager.js";
import type {
  CreatePolicyData,
  FindAuditQuery,
  FindPoliciesQuery,
  PermissionRepository,
  RecordAuditData,
  StoredPermissionAudit,
  StoredPermissionPolicy,
} from "@ai-desktop/storage";

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

describe("packages/permissions: Permission Revocation & Policy Lifecycle (PR24.11)", () => {
  it("revokes project-level permission and resets subsequent checks to requires_user", async () => {
    const storage = new InMemoryPermissionRepository();
    const emittedEvents: AIEvent[] = [];
    const manager = new DefaultPermissionManager({
      storage,
      eventSink: (event) => {
        emittedEvents.push(event as AIEvent);
      },
    });

    const check: PermissionCheck = {
      capability: "filesystem",
      action: "write",
      resource: "/workspace/src/code.ts",
      scope: "project",
      risk: "medium",
      relatedToolCallIds: [createToolCallId()],
    };

    // 1. Initial check -> requires_user
    const initial = await manager.check(check, { projectId: "proj-rev" });
    expect(initial.kind).toBe("requires_user");
    if (initial.kind !== "requires_user") return;

    // 2. Approve for project
    await manager.resolve({
      requestId: initial.request.id,
      decision: "granted",
      mode: "allow_project",
    });

    // 3. Recheck -> allowed
    expect((await manager.check(check, { projectId: "proj-rev" })).kind).toBe("allow");

    // 4. Revoke the policy
    const revokedCount = await manager.revoke({
      capability: "filesystem",
      projectId: "proj-rev",
    });
    expect(revokedCount).toBeGreaterThanOrEqual(1);

    // 5. Subsequent identical check MUST return requires_user again
    const afterRevoke = await manager.check(check, { projectId: "proj-rev" });
    expect(afterRevoke.kind).toBe("requires_user");

    // 6. Audit history is PRESERVED and not modified by revocation
    const audit = await storage.getAuditHistory({ projectId: "proj-rev" });
    expect(audit.length).toBeGreaterThanOrEqual(2);

    // 7. Canonical events emitted: permission.revoked and permission.policy.changed
    expect(emittedEvents.some((e) => e.type === "permission.revoked")).toBe(true);
    expect(emittedEvents.some((e) => e.type === "permission.policy.changed")).toBe(true);
  });

  it("revokes session-level permission and leaves unrelated capabilities active", async () => {
    const manager = new DefaultPermissionManager();

    const fsCheck: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/file.txt",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    const execCheck: PermissionCheck = {
      capability: "execution",
      action: "execute",
      resource: "npm run lint",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    // Grant both in session
    const fsReq = await manager.check(fsCheck);
    if (fsReq.kind === "requires_user") {
      await manager.resolve({
        requestId: fsReq.request.id,
        decision: "granted",
        mode: "allow_session",
      });
    }
    const execReq = await manager.check(execCheck);
    if (execReq.kind === "requires_user") {
      await manager.resolve({
        requestId: execReq.request.id,
        decision: "granted",
        mode: "allow_session",
      });
    }

    expect((await manager.check(fsCheck)).kind).toBe("allow");
    expect((await manager.check(execCheck)).kind).toBe("allow");

    // Revoke ONLY filesystem
    await manager.revoke({ capability: "filesystem" });

    // Filesystem now requires approval again
    expect((await manager.check(fsCheck)).kind).toBe("requires_user");

    // Execution remains allowed
    expect((await manager.check(execCheck)).kind).toBe("allow");
  });
});
