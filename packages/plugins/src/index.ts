// PR32: packages/plugins — Public API Surface
//
// Invariants:
//   1. Extension is an installable package, not an agent (no agent loop).
//   2. Capabilities are declarations, not permissions.
//   3. Trust != permission: definition changes require re-approval, and every
//      tool call still passes PermissionManager.check().
//   4. No Electron, no Prisma, no provider/MCP SDK in this package.

export type { ExtensionCapability } from "./core/capabilities.js";
export {
  EXTENSION_CAPABILITIES,
  ExtensionCapabilitySchema,
  normalizeCapabilities,
  validateCapabilities,
} from "./core/capabilities.js";

export type { ExtensionManifest, PluginToolContribution } from "./core/manifest.js";
export {
  ExtensionManifestSchema,
  PluginToolContributionSchema,
  SafeRelativePathSchema,
  isSafeRelativePath,
  SEMVER_PATTERN,
  EXTENSION_ID_PATTERN,
  MAX_MANIFEST_BYTES,
} from "./core/manifest.js";

export type { ExtensionLifecycle } from "./core/lifecycle.js";
export {
  canTransition,
  assertTransition,
  transitionLifecycle,
  initialLifecycle,
} from "./core/lifecycle.js";

export type { ExtensionRecord } from "./core/extension-registry.js";
export { ExtensionRegistry } from "./core/extension-registry.js";

export type { TrustState } from "./core/extension-trust.js";
export {
  computeExtensionDefinitionHash,
  trustRequiresReapproval,
  markTrustInvalidated,
} from "./core/extension-trust.js";

export type { BuildExtensionCustomEventParams } from "./core/extension-events.js";
export {
  buildExtensionCustomEvent,
  validateExtensionEvent,
  EXTENSION_EVENT_NAME_PATTERN,
  MAX_EXTENSION_EVENT_PAYLOAD_BYTES,
} from "./core/extension-events.js";

export type { PluginToolContributionInput } from "./tools/extension-tool-contribution.js";
export {
  PluginToolRegistry,
  toCanonicalPluginToolId,
  parseCanonicalPluginToolId,
  computePluginToolDefinitionHash,
  buildPluginToolDefinition,
} from "./tools/extension-tool-contribution.js";

export type {
  PersistedExtension,
  ExtensionRepository,
  ExtensionProjectBindingRepository,
  ExtensionManagerOptions,
} from "./core/extension-manager.js";
export { ExtensionManager } from "./core/extension-manager.js";

export type {
  ValidatedExtensionPackage,
  ExtensionInstallerOptions,
  InstallExtensionResult,
} from "./core/extension-installer.js";
export { validateExtensionPackage, ExtensionInstaller } from "./core/extension-installer.js";

export type {
  PluginToolHandler,
  ExecutePluginToolOptions,
  PluginToolExecutorOptions,
} from "./core/extension-tool-executor.js";
export { PluginToolExecutor } from "./core/extension-tool-executor.js";
