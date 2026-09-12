// PR25.4: packages/mcp — MCPHost Canonical Contract
//
// Invariants:
//   1. MCPHost is the single application-facing boundary for MCP servers.
//   2. Consumes canonical ToolDefinition and ToolResult from @ai-desktop/ai-core.
//   3. MCP SDK types (@modelcontextprotocol/sdk) must NEVER escape this package boundary.
//   4. Connection lifecycle: connect, disconnect, listTools, callTool.

import type { ToolDefinition, ToolResult } from "@ai-desktop/ai-core";
import type { McpServerConfig } from "./mcp-server-config.js";

export type McpConnectionState =
  "disconnected" | "connecting" | "connected" | "disconnecting" | "failed";

export interface McpServerInfo {
  readonly id: string;
  readonly name: string;
  readonly state: McpConnectionState;
  readonly toolCount: number;
  readonly error?: string;
}

export interface MCPHostEvents {
  onToolsChanged?: (serverId: string, tools: readonly ToolDefinition[]) => void;
  onStateChanged?: (serverId: string, state: McpConnectionState, error?: string) => void;
}

export interface MCPHost {
  /**
   * Connects to an MCP server using the provided configuration.
   * Safe and idempotent: returns existing connection if already connected.
   */
  connect(config: McpServerConfig): Promise<void>;

  /**
   * Disconnects from an active MCP server and cleans up resources.
   * Safe and idempotent.
   */
  disconnect(serverId: string): Promise<void>;

  /**
   * Lists all discovered canonical ToolDefinitions for a specific server or all connected servers.
   */
  listTools(serverId?: string): Promise<readonly ToolDefinition[]>;

  /**
   * Calls a tool on a connected MCP server and returns the canonical ToolResult.
   * Supports AbortSignal cooperative cancellation.
   */
  callTool(
    serverId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  /**
   * Returns current connection status for a server.
   */
  getServerStatus(serverId: string): McpServerInfo | undefined;

  /**
   * Lists all configured/connected server statuses.
   */
  listServers(): readonly McpServerInfo[];

  /**
   * Cleans up all server connections.
   */
  close(): Promise<void>;
}
