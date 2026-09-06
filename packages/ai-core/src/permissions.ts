// PR4: packages/ai-core — Canonical Permission Contracts
//
// Architectural Requirement:
//   ai-core owns the permission contract; packages/permissions owns the behavior.
//   PermissionRequest MUST include relatedToolCallIds: ToolCallId[] so a single
//   permission decision can be associated with one or more tool calls.

import { z } from "zod";
import type { PermissionRequestId, Timestamp, ToolCallId } from "@ai-desktop/shared";
import {
  PermissionRequestIdSchema,
  TimestampStringSchema,
  ToolCallIdSchema,
} from "@ai-desktop/shared";

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PermissionStatusSchema = z.enum(["pending", "granted", "denied", "expired"]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const PermissionScopeSchema = z.enum(["once", "session", "workspace", "always"]);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

/**
 * Canonical request for permission to execute a privileged capability.
 */
export const PermissionRequestSchema = z.object({
  id: PermissionRequestIdSchema,
  relatedToolCallIds: z
    .array(ToolCallIdSchema)
    .min(1, "PermissionRequest must relate to at least one tool call"),
  capability: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  scope: PermissionScopeSchema,
  risk: RiskLevelSchema,
  status: PermissionStatusSchema,
  reason: z.string().optional(),
  createdAt: TimestampStringSchema,
  resolvedAt: TimestampStringSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type PermissionRequest = {
  readonly id: PermissionRequestId;
  readonly relatedToolCallIds: readonly ToolCallId[];
  readonly capability: string;
  readonly action: string;
  readonly resource: string;
  readonly scope: PermissionScope;
  readonly risk: RiskLevel;
  readonly status: PermissionStatus;
  readonly reason?: string;
  readonly createdAt: Timestamp;
  readonly resolvedAt?: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Canonical resolution of a PermissionRequest.
 */
export const PermissionDecisionSchema = z.object({
  requestId: PermissionRequestIdSchema,
  decision: z.enum(["granted", "denied"]),
  scope: PermissionScopeSchema,
  reason: z.string().optional(),
  decidedAt: TimestampStringSchema,
  decidedBy: z.enum(["user", "policy", "auto"]),
});

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
