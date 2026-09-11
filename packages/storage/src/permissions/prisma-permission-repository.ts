// PR24.7: packages/storage — PrismaPermissionRepository Implementation
//
// Invariants:
//   - Persists project policies to SQLite permission_policies table.
//   - Persists append-only audit entries to permission_audit table.
//   - Raw secrets are never stored in policies or audit records.
//   - Epoch millisecond timestamps stored as BigInt and converted to Number on read.

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type {
  CreatePolicyData,
  FindAuditQuery,
  FindPoliciesQuery,
  PermissionRepository,
  RecordAuditData,
  StoredPermissionAudit,
  StoredPermissionPolicy,
} from "./permission-repository.js";

function toStoredPolicy(row: {
  id: string;
  projectId: string | null;
  capability: string;
  action: string | null;
  resourcePattern: string | null;
  decision: string;
  scope: string;
  createdAt: bigint;
  updatedAt: bigint;
  expiresAt: bigint | null;
}): StoredPermissionPolicy {
  return {
    id: row.id,
    projectId: row.projectId,
    capability: row.capability,
    action: row.action,
    resourcePattern: row.resourcePattern,
    decision: row.decision as "allow" | "deny",
    scope: row.scope,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    expiresAt: row.expiresAt ? Number(row.expiresAt) : null,
  };
}

function toStoredAudit(row: {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  permissionRequestId: string | null;
  capability: string;
  action: string;
  resource: string;
  scope: string;
  risk: string;
  decision: string;
  decidedBy: string;
  relatedToolCallIds: string;
  reason: string | null;
  timestamp: bigint;
}): StoredPermissionAudit {
  let toolCallIds: string[] = [];
  try {
    toolCallIds = JSON.parse(row.relatedToolCallIds);
  } catch {
    toolCallIds = [];
  }

  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    permissionRequestId: row.permissionRequestId,
    capability: row.capability,
    action: row.action,
    resource: row.resource,
    scope: row.scope,
    risk: row.risk,
    decision: row.decision,
    decidedBy: row.decidedBy,
    relatedToolCallIds: toolCallIds,
    reason: row.reason,
    timestamp: Number(row.timestamp),
  };
}

export class PrismaPermissionRepository implements PermissionRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async savePolicy(data: CreatePolicyData): Promise<StoredPermissionPolicy> {
    try {
      const row = await this._db.client.permissionPolicyRecord.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          projectId: data.projectId ?? null,
          capability: data.capability,
          action: data.action ?? null,
          resourcePattern: data.resourcePattern ?? null,
          decision: data.decision,
          scope: data.scope,
          createdAt: BigInt(data.createdAt),
          updatedAt: BigInt(data.updatedAt),
          expiresAt: data.expiresAt ? BigInt(data.expiresAt) : null,
        },
        update: {
          decision: data.decision,
          scope: data.scope,
          updatedAt: BigInt(data.updatedAt),
          expiresAt: data.expiresAt ? BigInt(data.expiresAt) : null,
        },
      });
      return toStoredPolicy(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to save permission policy "${data.id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async getPolicyById(id: string): Promise<StoredPermissionPolicy | null> {
    const row = await this._db.client.permissionPolicyRecord.findUnique({
      where: { id },
    });
    return row ? toStoredPolicy(row) : null;
  }

  async findPolicies(query?: FindPoliciesQuery): Promise<StoredPermissionPolicy[]> {
    const where: Record<string, unknown> = {};
    if (query?.projectId !== undefined) {
      where.projectId = query.projectId;
    }
    if (query?.capability !== undefined) {
      where.capability = query.capability;
    }
    if (query?.scope !== undefined) {
      where.scope = query.scope;
    }

    const rows = await this._db.client.permissionPolicyRecord.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toStoredPolicy);
  }

  async deletePolicy(id: string): Promise<void> {
    try {
      await this._db.client.permissionPolicyRecord.delete({
        where: { id },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return;
      }
      throw new StorageError(`Failed to delete permission policy "${id}": ${errString}`, {
        cause: err,
      });
    }
  }

  async deletePoliciesByCriteria(criteria: {
    capability: string;
    projectId?: string | null;
    resourcePattern?: string | null;
  }): Promise<number> {
    try {
      const where: Record<string, unknown> = {
        capability: criteria.capability,
      };
      if (criteria.projectId !== undefined) {
        where.projectId = criteria.projectId;
      }
      if (criteria.resourcePattern !== undefined) {
        where.resourcePattern = criteria.resourcePattern;
      }

      const res = await this._db.client.permissionPolicyRecord.deleteMany({
        where,
      });
      return res.count;
    } catch (err: unknown) {
      throw new StorageError(`Failed to delete policies by criteria: ${String(err)}`, {
        cause: err,
      });
    }
  }

  async recordAudit(data: RecordAuditData): Promise<StoredPermissionAudit> {
    try {
      const row = await this._db.client.permissionAuditRecord.create({
        data: {
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
          relatedToolCallIds: JSON.stringify(data.relatedToolCallIds),
          reason: data.reason ?? null,
          timestamp: BigInt(data.timestamp),
        },
      });
      return toStoredAudit(row);
    } catch (err: unknown) {
      throw new StorageError(
        `Failed to record permission audit entry "${data.id}": ${String(err)}`,
        {
          cause: err,
        },
      );
    }
  }

  async getAuditHistory(query?: FindAuditQuery): Promise<StoredPermissionAudit[]> {
    const where: Record<string, unknown> = {};
    if (query?.projectId) {
      where.projectId = query.projectId;
    }
    if (query?.capability) {
      where.capability = query.capability;
    }
    if (query?.conversationId) {
      where.conversationId = query.conversationId;
    }

    const rows = await this._db.client.permissionAuditRecord.findMany({
      where,
      orderBy: { timestamp: "asc" },
      take: query?.limit,
    });
    return rows.map(toStoredAudit);
  }
}
