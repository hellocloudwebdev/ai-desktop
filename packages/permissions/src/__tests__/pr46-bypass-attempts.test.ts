// PR46: packages/permissions — Bypass-Attempt Suite (adversarial)
//
// Locks: deny precedence over allow, revocation sticks (no stale allow),
// unauthenticated/default is never allow, scope escalation rejected
// (session grant does not satisfy project checks via exact matching).

import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import type { PermissionCheck } from "@ai-desktop/ai-core";
import { DefaultPermissionManager } from "../core/default-permission-manager.js";
import { PermissionPolicyEvaluator } from "../core/policy-evaluator.js";
import type { PermissionPolicy } from "../core/permission-policy.js";
import type {
  CreatePolicyData,
  FindPoliciesQuery,
  PermissionRepository,
  RecordAuditData,
  StoredPermissionAudit,
  StoredPermissionPolicy,
} from "@ai-desktop/storage";

class InMemoryPermissionRepository implements PermissionRepository {
  private readonly _policies = new Map<string, StoredPermissionPolicy>();
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
    return {
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
  }
  async getAuditHistory(): Promise<StoredPermissionAudit[]> {
    return [];
  }
}

function check(overrides: Partial<PermissionCheck> = {}): PermissionCheck {
  return {
    capability: "mcp",
    action: "call",
    resource: "mcp:server/tool",
    scope: "once",
    risk: "medium",
    relatedToolCallIds: [createToolCallId()],
    ...overrides,
  };
}

function policy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  const nowMs = Date.now();
  return {
    id: `pol-${Math.random().toString(36).slice(2)}`,
    capability: "mcp",
    decision: "allow",
    scope: "session",
    createdAt: nowMs,
    updatedAt: nowMs,
    ...overrides,
  };
}

describe("permissions bypass: deny precedence", () => {
  it("explicit deny beats allow even when allow matches first", () => {
    const evaluator = new PermissionPolicyEvaluator();
    const result = evaluator.evaluate(check(), [
      policy({ id: "allow-1", decision: "allow" }),
      policy({ id: "deny-1", decision: "deny" }),
    ]);
    expect(result.kind).toBe("deny");
  });

  it("deny on a different capability does not bleed over", () => {
    const evaluator = new PermissionPolicyEvaluator();
    const result = evaluator.evaluate(check({ capability: "mcp" }), [
      policy({ capability: "execution", decision: "deny" }),
    ]);
    expect(result.kind).toBe("requires_user");
  });

  it("manager surfaces deny (not requires_user) through check()", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });
    await storage.savePolicy({
      id: "deny-mcp",
      projectId: null,
      capability: "mcp",
      action: null,
      resourcePattern: null,
      decision: "deny",
      scope: "session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const result = await manager.check(check());
    expect(result.kind).toBe("deny");
  });
});

describe("permissions bypass: revocation sticks", () => {
  it("revoked allow no longer authorizes (next check requires_user)", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });
    await storage.savePolicy({
      id: "allow-mcp",
      projectId: null,
      capability: "mcp",
      action: null,
      resourcePattern: null,
      decision: "allow",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect((await manager.check(check())).kind).toBe("allow");
    const revoked = await manager.revoke({ capability: "mcp", scope: "project" });
    expect(revoked).toBeGreaterThanOrEqual(1);
    expect((await manager.check(check())).kind).toBe("requires_user");
  });

  it("revocation is scoped: revoking execution does not revoke mcp", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });
    await storage.savePolicy({
      id: "allow-mcp-2",
      projectId: null,
      capability: "mcp",
      action: null,
      resourcePattern: null,
      decision: "allow",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await manager.revoke({ capability: "execution", scope: "project" });
    expect((await manager.check(check())).kind).toBe("allow");
  });
});

describe("permissions bypass: unauthenticated never equals allow", () => {
  it("no policies yields requires_user (never allow)", async () => {
    const manager = new DefaultPermissionManager({});
    const result = await manager.check(check());
    expect(result.kind).toBe("requires_user");
  });

  it("resolving an unknown request is idempotent false (no phantom grant)", async () => {
    const manager = new DefaultPermissionManager({});
    const first = await manager.check(check());
    expect(first.kind).toBe("requires_user");
    const unknown = await manager.resolve({
      requestId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
      decision: "granted",
      mode: "allow_once",
    });
    expect(unknown).toBe(false);
  });

  it("allow_once grants exactly the authorized toolCallIds (replay fails closed)", async () => {
    const manager = new DefaultPermissionManager({});
    const toolCallId = createToolCallId();
    const pending = await manager.check(check({ relatedToolCallIds: [toolCallId] }));
    expect(pending.kind).toBe("requires_user");
    if (pending.kind !== "requires_user") throw new Error("expected pending");
    expect(
      await manager.resolve({
        requestId: pending.request.id,
        decision: "granted",
        mode: "allow_once",
      }),
    ).toBe(true);
    expect((await manager.check(check({ relatedToolCallIds: [toolCallId] }))).kind).toBe("allow");
    // Consumed: a second use of the same toolCallId must not re-allow.
    expect((await manager.check(check({ relatedToolCallIds: [toolCallId] }))).kind).toBe(
      "requires_user",
    );
  });
});

describe("permissions bypass: scope escalation rejected", () => {
  it("secrets.use policy never authorizes secrets.read (strictly distinct)", () => {
    const evaluator = new PermissionPolicyEvaluator();
    const result = evaluator.evaluate(
      check({ capability: "secrets.read", resource: "app/provider/x/api-key" }),
      [policy({ capability: "secrets.use", resourcePattern: "app/provider/x/api-key" })],
    );
    expect(result.kind).toBe("requires_user");
  });

  it("narrow filesystem grant does not authorize sibling paths", async () => {
    const storage = new InMemoryPermissionRepository();
    const manager = new DefaultPermissionManager({ storage });
    await storage.savePolicy({
      id: "fs-narrow",
      projectId: null,
      capability: "filesystem",
      action: null,
      resourcePattern: "/proj/a/allowed",
      decision: "allow",
      scope: "session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const ok = await manager.check(
      check({ capability: "filesystem", action: "read", resource: "/proj/a/allowed/file.txt" }),
    );
    expect(ok.kind).toBe("allow");
    const sibling = await manager.check(
      check({
        capability: "filesystem",
        action: "read",
        resource: "/proj/a/allowed-evil/file.txt",
      }),
    );
    expect(sibling.kind).not.toBe("allow");
  });

  it("expired policy never authorizes (time is a boundary)", () => {
    const evaluator = new PermissionPolicyEvaluator();
    const result = evaluator.evaluate(check(), [
      policy({ decision: "allow", expiresAt: Date.now() - 1_000 }),
    ]);
    expect(result.kind).toBe("requires_user");
  });
});
