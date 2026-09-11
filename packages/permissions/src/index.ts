// PR7 & PR24: packages/permissions — Public API Surface
//
// Establishes the real PermissionManager implementation, policy evaluator,
// and canonical permission contracts.

export type {
  PermissionManager,
  ResolvePermissionInput,
  RevokePermissionInput,
  CheckPermissionOptions,
} from "./core/permission-manager.js";
export {
  DefaultPermissionManager,
  type DefaultPermissionManagerOptions,
} from "./core/default-permission-manager.js";
export { AllowAllPermissionManager } from "./allow-all/allow-all-permission-manager.js";

// Policy model and evaluator (PR24)
export type { PermissionPolicy, CreatePolicyInput } from "./core/permission-policy.js";
export {
  PermissionPolicySchema,
  matchesPolicy,
  matchesFilesystemPath,
  matchesExecutionCommand,
  normalizePath,
} from "./core/permission-policy.js";
export { PermissionPolicyEvaluator, defaultPolicyEvaluator } from "./core/policy-evaluator.js";

// Re-export canonical domain types from ai-core for consumer convenience
export type {
  PermissionCheck,
  PermissionDecisionResult,
  PermissionRequest,
  PermissionRequestId,
  PermissionScope,
  RiskLevel,
  UserApprovalMode,
} from "@ai-desktop/ai-core";
