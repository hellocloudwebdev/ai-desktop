// PR25: packages/mcp — Public API Surface
//
// Invariants:
//   1. MCPHost is the consumer boundary for Agent Runtime.
//   2. MCP SDK types (@modelcontextprotocol/sdk) are strictly encapsulated in this package.
//   3. Tools discovered have source="mcp" and runtime="mcp_protocol".
//   4. Permission evaluation is enforced through PermissionManager before execution.

export type { McpServerConfig, McpTransportType } from "./core/mcp-server-config.js";
export { McpServerConfigSchema, McpTransportTypeSchema } from "./core/mcp-server-config.js";

export type { MCPHost, MCPHostEvents, McpConnectionState, McpServerInfo } from "./core/mcp-host.js";

export { InProcessMCPHost } from "./core/in-process-mcp-host.js";

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
