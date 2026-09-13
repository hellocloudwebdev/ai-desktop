// PR32: apps/desktop — Extensions Barrel (desktop-owned orchestration)
//
// Re-exports the @ai-desktop/plugins domain primitives the desktop host
// composes, plus the desktop-owned ExtensionService. The canonical manifest,
// registry, lifecycle, trust, validation, tool contribution, and executor
// implementations live in @ai-desktop/plugins; the desktop owns only
// orchestration over storage + PermissionManager + host tool handlers.

export {
  toCanonicalPluginToolId,
  parseCanonicalPluginToolId,
  computePluginToolDefinitionHash,
  buildPluginToolDefinition,
  PluginToolRegistry,
} from "@ai-desktop/plugins";
export type { PluginToolContributionInput } from "@ai-desktop/plugins";
export { PluginToolExecutor } from "@ai-desktop/plugins";
export type {
  PluginToolHandler,
  ExecutePluginToolOptions,
  PluginToolExecutorOptions,
} from "@ai-desktop/plugins";
export {
  ExtensionManifestSchema,
  PluginToolContributionSchema,
  SafeRelativePathSchema,
  isSafeRelativePath,
  computeExtensionDefinitionHash,
  validateExtensionPackage,
  EXTENSION_CAPABILITIES,
  EXTENSION_ID_PATTERN,
  SEMVER_PATTERN,
  MAX_MANIFEST_BYTES,
} from "@ai-desktop/plugins";
export type {
  ExtensionManifest,
  PluginToolContribution,
  ValidatedExtensionPackage,
} from "@ai-desktop/plugins";
export type { ExtensionLifecycle } from "@ai-desktop/plugins";
export type { TrustState as ExtensionTrust } from "@ai-desktop/plugins";
export { ExtensionService } from "./extension-service.js";
export type { ExtensionServiceOptions } from "./extension-service.js";
