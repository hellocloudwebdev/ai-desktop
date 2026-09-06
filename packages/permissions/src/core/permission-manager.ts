// PR7: packages/permissions — Canonical PermissionManager Interface
//
// Architectural Scope:
//   PermissionManager is the primary abstraction that tool executors, agent loops,
//   and capability execution paths depend on.
//   Consumers depend on PermissionManager, NOT AllowAllPermissionManager.

import type { PermissionCheck, PermissionDecisionResult } from "@ai-desktop/ai-core";

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
   * @returns Resolves to PermissionDecisionResult ("allow" | "deny" | "requires_user").
   */
  check(request: PermissionCheck): Promise<PermissionDecisionResult>;
}
