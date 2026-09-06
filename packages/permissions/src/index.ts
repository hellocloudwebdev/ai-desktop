// PR7: packages/permissions — Public API Surface
//
// Establishes the PermissionManager abstraction and Phase-0 AllowAllPermissionManager.
// Canonical domain types (PermissionCheck, PermissionDecisionResult, RiskLevel, etc.)
// are re-exported directly from @ai-desktop/ai-core.

export type { PermissionManager } from "./core/permission-manager.js";
export { AllowAllPermissionManager } from "./allow-all/allow-all-permission-manager.js";

// Re-export canonical domain types from ai-core for consumer convenience
export type {
  PermissionCheck,
  PermissionDecisionResult,
  PermissionScope,
  RiskLevel,
  UserApprovalMode,
} from "@ai-desktop/ai-core";
