// PR24.7: packages/storage — PermissionRepository Interface
//
// Architectural Scope:
//   - Storage abstraction for persistent permission policies and append-only audit events.
//   - Zero Prisma imports outside packages/storage.
//   - Audit history is strictly append-only (no update or delete APIs).
//   - Raw secrets (API keys, OAuth tokens) are never stored in policies or audit records.

export interface StoredPermissionPolicy {
  readonly id: string;
  readonly projectId: string | null;
  readonly capability: string;
  readonly action: string | null;
  readonly resourcePattern: string | null;
  readonly decision: "allow" | "deny";
  readonly scope: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
}

export interface CreatePolicyData {
  readonly id: string;
  readonly projectId?: string | null;
  readonly capability: string;
  readonly action?: string | null;
  readonly resourcePattern?: string | null;
  readonly decision: "allow" | "deny";
  readonly scope: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number | null;
}

export interface FindPoliciesQuery {
  readonly projectId?: string | null;
  readonly capability?: string;
  readonly scope?: string;
}

export interface StoredPermissionAudit {
  readonly id: string;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly permissionRequestId: string | null;
  readonly capability: string;
  readonly action: string;
  readonly resource: string;
  readonly scope: string;
  readonly risk: string;
  readonly decision: string;
  readonly decidedBy: string;
  readonly relatedToolCallIds: readonly string[];
  readonly reason: string | null;
  readonly timestamp: number;
}

export interface RecordAuditData {
  readonly id: string;
  readonly projectId?: string | null;
  readonly conversationId?: string | null;
  readonly permissionRequestId?: string | null;
  readonly capability: string;
  readonly action: string;
  readonly resource: string;
  readonly scope: string;
  readonly risk: string;
  readonly decision: string;
  readonly decidedBy: string;
  readonly relatedToolCallIds: readonly string[];
  readonly reason?: string | null;
  readonly timestamp: number;
}

export interface FindAuditQuery {
  readonly projectId?: string;
  readonly capability?: string;
  readonly conversationId?: string;
  readonly limit?: number;
}

export interface PermissionRepository {
  // Policy management
  savePolicy(data: CreatePolicyData): Promise<StoredPermissionPolicy>;
  getPolicyById(id: string): Promise<StoredPermissionPolicy | null>;
  findPolicies(query?: FindPoliciesQuery): Promise<StoredPermissionPolicy[]>;
  deletePolicy(id: string): Promise<void>;
  deletePoliciesByCriteria(criteria: {
    capability: string;
    projectId?: string | null;
    resourcePattern?: string | null;
  }): Promise<number>;

  // Append-only audit history
  recordAudit(data: RecordAuditData): Promise<StoredPermissionAudit>;
  getAuditHistory(query?: FindAuditQuery): Promise<StoredPermissionAudit[]>;
}
