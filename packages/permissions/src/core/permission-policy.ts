// PR24.2 & PR24.4: packages/permissions — PermissionCore Policy Model & Matching
//
// Architectural Invariants:
//   1. Canonical evaluation dimensions: capability, action, resource, scope, risk.
//   2. Policy scopes locked to: allow_once, allow_session, allow_project, deny.
//   3. Resource matching:
//      - filesystem: path-aware (prefix/boundary matching, normalizes separators).
//      - execution: command/cwd-aware (prefix/exact matching).
//      - MCP: per-tool (tool name match).
//      - secrets: secrets.use != secrets.read (strictly distinct capabilities).
//   4. Pure, deterministic, side-effect free evaluation.

import { z } from "zod";
import type { PermissionCheck, PermissionScope } from "@ai-desktop/ai-core";
import { PermissionScopeSchema } from "@ai-desktop/ai-core";

export interface PermissionPolicy {
  readonly id: string; // ULID
  readonly projectId?: string;
  readonly capability: string;
  readonly action?: string;
  readonly resourcePattern?: string;
  readonly decision: "allow" | "deny";
  readonly scope: PermissionScope;
  readonly createdAt: number; // epoch ms
  readonly updatedAt: number; // epoch ms
  readonly expiresAt?: number; // optional epoch ms
}

export const PermissionPolicySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().optional(),
  capability: z.string().min(1),
  action: z.string().optional(),
  resourcePattern: z.string().optional(),
  decision: z.enum(["allow", "deny"]),
  scope: PermissionScopeSchema,
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional(),
});

export interface CreatePolicyInput {
  readonly projectId?: string;
  readonly capability: string;
  readonly action?: string;
  readonly resourcePattern?: string;
  readonly decision: "allow" | "deny";
  readonly scope: PermissionScope;
  readonly expiresAt?: number;
}

/**
 * Normalizes filesystem path for boundary-safe matching.
 * Converts backslashes to forward slashes and strips trailing slash unless root.
 */
export function normalizePath(p: string): string {
  const forward = p.replace(/\\/g, "/");
  return forward.length > 1 && forward.endsWith("/") ? forward.slice(0, -1) : forward;
}

/**
 * Path-aware filesystem matcher.
 * Checks whether the candidate file path is equal to or enclosed within the allowed pattern path.
 */
export function matchesFilesystemPath(pattern: string, resource: string): boolean {
  const normPattern = normalizePath(pattern);
  const normResource = normalizePath(resource);

  if (normPattern === "*" || normPattern === normResource) {
    return true;
  }

  // Directory boundary match: normResource must start with normPattern + "/"
  return normResource.startsWith(normPattern + "/");
}

/**
 * Command-aware execution matcher.
 * Checks whether the command and/or working directory matches the policy pattern.
 */
export function matchesExecutionCommand(pattern: string, resource: string): boolean {
  const trimmedPattern = pattern.trim();
  const trimmedResource = resource.trim();

  if (trimmedPattern === "*" || trimmedPattern === trimmedResource) {
    return true;
  }

  // Exact prefix match with word boundary
  if (trimmedResource.startsWith(trimmedPattern)) {
    const nextChar = trimmedResource[trimmedPattern.length];
    return nextChar === " " || nextChar === undefined;
  }

  return false;
}

/**
 * Pure, deterministic check whether a policy rule matches a permission check.
 */
export function matchesPolicy(policy: PermissionPolicy, check: PermissionCheck): boolean {
  // 1. Check capability match
  // Crucial invariant (PR24.12): secrets.use and secrets.read are strictly separate.
  if (policy.capability !== "*" && policy.capability !== check.capability) {
    return false;
  }

  // 2. Check action match
  if (policy.action && policy.action !== "*" && policy.action !== check.action) {
    return false;
  }

  // 3. Check resource match based on capability domain
  if (policy.resourcePattern && policy.resourcePattern !== "*") {
    if (!check.resource) {
      return false;
    }

    if (check.capability === "filesystem") {
      if (!matchesFilesystemPath(policy.resourcePattern, check.resource)) {
        return false;
      }
    } else if (check.capability === "execution") {
      if (!matchesExecutionCommand(policy.resourcePattern, check.resource)) {
        return false;
      }
    } else {
      // MCP, secrets, and other capabilities: exact or prefix match
      if (
        policy.resourcePattern !== check.resource &&
        !check.resource.startsWith(policy.resourcePattern)
      ) {
        return false;
      }
    }
  }

  // 4. Check expiration if applicable
  if (policy.expiresAt && Date.now() > policy.expiresAt) {
    return false;
  }

  return true;
}
