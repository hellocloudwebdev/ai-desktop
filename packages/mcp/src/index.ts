// PR25: packages/mcp — Public API Surface
//
// Invariants:
//   1. MCPHost is the consumer boundary for Agent Runtime.
//   2. MCP SDK types (@modelcontextprotocol/sdk) are strictly encapsulated in this package.
//   3. Tools discovered have source="mcp" and runtime="mcp_protocol".
//   4. Permission evaluation is enforced through PermissionManager before execution.

export type {
  McpServerConfig,
  McpTransportType,
  McpEnvValue,
  McpEnvSecretRef,
} from "./core/mcp-server-config.js";
export {
  McpServerConfigSchema,
  McpTransportTypeSchema,
  McpEnvValueSchema,
  McpEnvSecretRefSchema,
  isMcpEnvSecretRef,
} from "./core/mcp-server-config.js";

export type {
  MCPHost,
  MCPHostEvents,
  McpConnectionState,
  McpServerInfo,
  McpResourceInfo,
  McpResourceTemplateInfo,
  McpPromptInfo,
  McpResourceContent,
  McpPromptResult,
  McpSubscription,
  McpServerHealth,
} from "./core/mcp-host.js";

export type {
  McpClientLike,
  McpClientFactory,
  InProcessMCPHostDeps,
} from "./core/in-process-mcp-host.js";
export { InProcessMCPHost, MCP_NOTIFICATION_METHODS } from "./core/in-process-mcp-host.js";

export type {
  DiscoveredCapabilities,
  CapabilityDiscoveryClient,
} from "./core/mcp-capability-discovery.js";
export { CapabilityDiscovery, EMPTY_CAPABILITIES } from "./core/mcp-capability-discovery.js";

export type { ToolDefinitionChange, ToolRegistryEvents } from "./core/tool-registry.js";
export { ToolRegistry } from "./core/tool-registry.js";

export type { ExecuteMcpToolOptions, McpToolExecutorEvents } from "./core/mcp-tool-executor.js";
export { McpToolExecutor, MAX_RESULT_BYTES } from "./core/mcp-tool-executor.js";

export {
  toCanonicalToolId,
  parseCanonicalToolId,
  computeToolDefinitionHash,
  convertMcpToolToDefinition,
  convertMcpCallResultToToolResult,
} from "./core/tool-converter.js";

export type {
  McpAppToolResultInput,
  McpAppActionInput,
  McpAppActionBinding,
  McpAppActionContext,
  McpAppActionResult,
} from "./core/mcp-app-surface.js";
export { buildMcpAppDescriptor, validateMcpAppAction } from "./core/mcp-app-surface.js";
