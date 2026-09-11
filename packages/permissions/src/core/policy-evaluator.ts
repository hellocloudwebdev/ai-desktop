// PR24.3: packages/permissions — Pure Deterministic Policy Evaluator
//
// Invariants:
//   1. Evaluates permission check against active policy rules.
//   2. Output space is strictly: { kind: "allow" } | { kind: "deny" } | { kind: "requires_user" }.
//   3. Precedence: explicit deny rules take absolute precedence over allow rules.
//   4. Pure, deterministic, side-effect free: zero I/O, zero state mutation.

import type { PermissionCheck } from "@ai-desktop/ai-core";
import { matchesPolicy, type PermissionPolicy } from "./permission-policy.js";

export class PermissionPolicyEvaluator {
  /**
   * Evaluates a permission check against an ordered list of active policy rules.
   *
   * Evaluation rules:
   *   1. If any matching policy has decision === "deny", returns { kind: "deny" }.
   *   2. If any matching policy has decision === "allow", returns { kind: "allow" }.
   *   3. If no matching policy rule exists, returns { kind: "requires_user" }.
   *
   * Note: The PermissionRequest generation for "requires_user" is handled by the caller.
   */
  evaluate(
    check: PermissionCheck,
    activePolicies: readonly PermissionPolicy[],
  ): { kind: "allow" } | { kind: "deny"; reason?: string } | { kind: "requires_user" } {
    let matchedAllow: PermissionPolicy | undefined;

    for (const policy of activePolicies) {
      if (matchesPolicy(policy, check)) {
        // Explicit deny rule takes highest precedence
        if (policy.decision === "deny") {
          return {
            kind: "deny",
            reason: `Operation denied by policy rule "${policy.id}" for capability "${check.capability}"`,
          };
        }

        if (policy.decision === "allow" && !matchedAllow) {
          matchedAllow = policy;
        }
      }
    }

    if (matchedAllow) {
      return { kind: "allow" };
    }

    return { kind: "requires_user" };
  }
}

export const defaultPolicyEvaluator = new PermissionPolicyEvaluator();
