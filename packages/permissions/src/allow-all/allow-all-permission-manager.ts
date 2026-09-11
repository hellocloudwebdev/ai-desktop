// PR7: packages/permissions — AllowAllPermissionManager
//
// Phase-0 permissive implementation of PermissionManager.
//
// Invariants:
//   - Validates input strictly: malformed requests are rejected (throwing ValidationError).
//   - Valid requests unconditionally evaluate to { kind: "allow" }.
//   - No state is stored (no previous requests, no approval grants, no policy state).
//   - Deterministic: the same valid request always returns allow.
//   - Zero persistence: no Prisma, no SQLite, no permission tables.
//   - Zero sandboxing: sandboxing belongs exclusively to packages/execution.
//   - Zero UI: interactive dialogs belong to later approval phases.

import type { z } from "zod";
import {
  type PermissionCheck,
  PermissionCheckSchema,
  type PermissionDecisionResult,
  type PermissionRequest,
} from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import type { PermissionManager } from "../core/permission-manager.js";
import type { PermissionPolicy } from "../core/permission-policy.js";

export class AllowAllPermissionManager implements PermissionManager {
  /**
   * Validates the permission check input and unconditionally allows valid requests.
   * Throws ValidationError if the request does not conform to the canonical PermissionCheckSchema.
   */
  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    const parseResult = PermissionCheckSchema.safeParse(request);

    if (!parseResult.success) {
      const errorDetails = parseResult.error.issues
        .map((issue: z.ZodIssue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      throw new ValidationError(`Invalid permission request: ${errorDetails}`, {
        details: parseResult.error.issues,
      });
    }

    return { kind: "allow" };
  }

  async resolve(): Promise<boolean> {
    return false;
  }

  async revoke(): Promise<number> {
    return 0;
  }

  getPendingRequest(): PermissionRequest | undefined {
    return undefined;
  }

  listPendingRequests(): readonly PermissionRequest[] {
    return [];
  }

  async listActivePolicies(): Promise<readonly PermissionPolicy[]> {
    return [];
  }
}
