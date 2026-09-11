// PR7 & PR24: packages/permissions — Canonical PermissionManager Interface
//
// Architectural Scope:
//   PermissionManager is the primary checkpoint abstraction that tool executors,
//   agent loops, and capability execution paths must be mediated through.
//   Every tool execution path calls PermissionManager.check() before execution.

import type {
  PermissionCheck,
  PermissionDecisionResult,
  PermissionRequest,
  PermissionRequestId,
  UserApprovalMode,
} from "@ai-desktop/ai-core";
import type { PermissionPolicy } from "./permission-policy.js";

export interface ResolvePermissionInput {
  readonly requestId: PermissionRequestId;
  readonly decision: "granted" | "denied";
  readonly mode: UserApprovalMode; // "allow_once" | "allow_session" | "allow_project" | "deny"
  readonly reason?: string;
}

export interface RevokePermissionInput {
  readonly capability: string;
  readonly projectId?: string;
  readonly resourcePattern?: string;
  readonly scope?: "session" | "project";
}

export interface CheckPermissionOptions {
  readonly projectId?: string;
  readonly conversationId?: string;
  readonly batchId?: string;
}

/**
 * Primary interface for evaluating capability permissions.
 */
export interface PermissionManager {
  /**
   * Checks whether the specified capability operation is permitted.
   * Evaluates across the 5 canonical dimensions: capability, action, resource, scope, risk,
   * with relatedToolCallIds preserved for coalescing.
   *
   * @param request Validated permission check input.
   * @param options Optional context including projectId, conversationId, and batchId.
   * @returns Resolves to PermissionDecisionResult ("allow" | "deny" | "requires_user").
   */
  check(
    request: PermissionCheck,
    options?: CheckPermissionOptions,
  ): Promise<PermissionDecisionResult>;

  /**
   * Resolves an outstanding PermissionRequest after human/UI confirmation.
   * Safe and idempotent: returns true on first resolution, false if already resolved or unknown.
   */
  resolve(input: ResolvePermissionInput): Promise<boolean>;

  /**
   * Revokes matching permission policies, resetting state so subsequent calls require approval.
   * Historical audit records are never rewritten or deleted.
   * Returns count of revoked policies.
   */
  revoke(input: RevokePermissionInput): Promise<number>;

  /**
   * Retrieves an active pending PermissionRequest by ID.
   */
  getPendingRequest(requestId: PermissionRequestId): PermissionRequest | undefined;

  /**
   * Lists all currently pending PermissionRequests.
   */
  listPendingRequests(): readonly PermissionRequest[];

  /**
   * Lists active policies (combining session in-memory and persistent storage).
   */
  listActivePolicies(projectId?: string): Promise<readonly PermissionPolicy[]>;
}
