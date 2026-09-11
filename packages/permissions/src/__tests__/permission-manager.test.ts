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

describe("packages/permissions: DefaultPermissionManager (PR24)", () => {
  it("returns requires_user for unapproved requests and emits permission.requested", async () => {
    const emittedEvents: AIEvent[] = [];
    const manager = new DefaultPermissionManager({
      eventSink: (event) => {
        emittedEvents.push(event as AIEvent);
      },
    });

    const toolCallId = createToolCallId();
    const check: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/config.json",
      scope: "once",
      risk: "low",
      relatedToolCallIds: [toolCallId],
    };

    const res = await manager.check(check, { conversationId: "conv-1" });
    expect(res.kind).toBe("requires_user");

    if (res.kind === "requires_user") {
      expect(res.request.relatedToolCallIds).toContain(toolCallId);
      expect(res.request.capability).toBe("filesystem");
      expect(res.request.status).toBe("pending");
    }

    // Event emission check
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].type).toBe("permission.requested");
  });

  it("handles allow_once: approves specific toolCallId and consumes grant", async () => {
    const manager = new DefaultPermissionManager();
    const toolCallId = createToolCallId();

    const check: PermissionCheck = {
      capability: "execution",
      action: "execute",
      resource: "npm run test",
      scope: "once",
      risk: "medium",
      relatedToolCallIds: [toolCallId],
    };

    // Step 1: initial check -> requires_user
    const initial = await manager.check(check);
    expect(initial.kind).toBe("requires_user");
    if (initial.kind !== "requires_user") return;

    // Step 2: user resolves with allow_once
    const resolved = await manager.resolve({
      requestId: initial.request.id,
      decision: "granted",
      mode: "allow_once",
    });
    expect(resolved).toBe(true);

    // Step 3: second check with same toolCallId -> allowed!
    const recheck = await manager.check(check);
    expect(recheck.kind).toBe("allow");

    // Step 4: third check with a NEW toolCallId -> requires_user again (once consumed!)
    const nextCheck: PermissionCheck = {
      ...check,
      relatedToolCallIds: [createToolCallId()],
    };
    const thirdCheck = await manager.check(nextCheck);
    expect(thirdCheck.kind).toBe("requires_user");
  });

  it("handles allow_session: persists grant in memory across multiple tool calls", async () => {
    const manager = new DefaultPermissionManager();

    const check1: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };

    const initial = await manager.check(check1);
    expect(initial.kind).toBe("requires_user");
    if (initial.kind !== "requires_user") return;

    // Resolve with allow_session
    await manager.resolve({
      requestId: initial.request.id,
      decision: "granted",
      mode: "allow_session",
    });

    // Second check in session for enclosed file -> allowed!
    const check2: PermissionCheck = {
      capability: "filesystem",
      action: "read",
      resource: "/workspace/src/utils.ts",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [createToolCallId()],
    };
    expect((await manager.check(check2)).kind).toBe("allow");
  });

  it("handles allow_project with strict project isolation (does NOT leak to project B)", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });

    const checkProjectA: PermissionCheck = {
      capability: "mcp",
      action: "call",
      resource: "github/list_issues",
      scope: "project",
      risk: "medium",
      relatedToolCallIds: [createToolCallId()],
    };

    // Project A initial check -> requires_user
    const initialA = await manager.check(checkProjectA, { projectId: "project-A" });
    expect(initialA.kind).toBe("requires_user");
    if (initialA.kind !== "requires_user") return;

    // Approve for project A
    await manager.resolve({
      requestId: initialA.request.id,
      decision: "granted",
      mode: "allow_project",
    });

    // Recheck in project A -> allowed!
    expect((await manager.check(checkProjectA, { projectId: "project-A" })).kind).toBe("allow");

    // Check same tool in project B -> MUST return requires_user (project isolation!)
    const checkProjectB: PermissionCheck = {
      ...checkProjectA,
      relatedToolCallIds: [createToolCallId()],
    };
    expect((await manager.check(checkProjectB, { projectId: "project-B" })).kind).toBe(
      "requires_user",
    );
  });

  it("handles deny decision: denies subsequent checks", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });

    const check: PermissionCheck = {
      capability: "execution",
      action: "execute",
      resource: "dangerous_script.sh",
      scope: "project",
      risk: "critical",
      relatedToolCallIds: [createToolCallId()],
    };

    const initial = await manager.check(check, { projectId: "proj-1" });
    expect(initial.kind).toBe("requires_user");
    if (initial.kind !== "requires_user") return;

    // Deny request
    await manager.resolve({
      requestId: initial.request.id,
      decision: "denied",
      mode: "deny",
      reason: "Dangerous command prohibited",
    });

    // Subsequent check is denied
    const denied = await manager.check(check, { projectId: "proj-1" });
    expect(denied.kind).toBe("deny");
  });

  it("records immutable audit log without raw credentials or secrets", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });

    const check: PermissionCheck = {
      capability: "secrets.use",
      action: "use",
      resource: "app/provider/gemini/api-key", // Credential reference, NOT secret value
      scope: "once",
      risk: "high",
      relatedToolCallIds: [createToolCallId()],
    };

    await manager.check(check, { projectId: "proj-sec", conversationId: "conv-sec" });

    const audit = await storage.getAuditHistory({ projectId: "proj-sec" });
    expect(audit).toHaveLength(1);
    expect(audit[0].capability).toBe("secrets.use");
    expect(audit[0].resource).toBe("app/provider/gemini/api-key");
    // Verify audit entry doesn't have secret keys
    expect(JSON.stringify(audit[0])).not.toContain("sk-");
    expect(JSON.stringify(audit[0])).not.toContain("AIza");
  });
});
