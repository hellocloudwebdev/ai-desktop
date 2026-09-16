// PR25.4 + PR38: packages/mcp — MCPHost Canonical Contract
//
// Invariants:
//   1. MCPHost is the single application-facing boundary for MCP servers.
//   2. Consumes canonical ToolDefinition and ToolResult from @ai-desktop/ai-core.
//   3. MCP SDK types (@modelcontextprotocol/sdk) must NEVER escape this package boundary.
//   4. Connection lifecycle: connect, disconnect, listTools, callTool.
//   5. PR38 adds resources, prompts, and subscriptions plus capability events;
//      all additions are optional or additive so existing consumers keep working.

import type { ToolDefinition, ToolResult } from "@ai-desktop/ai-core";
import type { DiscoveredCapabilities } from "./mcp-capability-discovery.js";
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

/** Discovered resource descriptor (canonical, SDK-free). */
export interface McpResourceInfo {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** Discovered resource template descriptor (canonical, SDK-free). */
export interface McpResourceTemplateInfo {
  readonly uriTemplate: string;
  readonly name: string;
}

/** Discovered prompt descriptor (canonical, SDK-free). */
export interface McpPromptInfo {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly { readonly name: string; readonly required?: boolean }[];
}

/** Normalized resource content returned by readResource. */
export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blobBase64?: string;
  readonly truncated?: boolean;
}

/**
 * Normalized prompt result. UNTRUSTED EXTERNAL CONTENT: `framed: true` marks
 * that the host normalized this payload; framing (frameMcpContent) is applied
 * at the ai-core boundary by the caller. Never treat as instructions.
 */
export interface McpPromptResult {
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
  readonly framed: true;
}

/** Active resource subscription record. */
export interface McpSubscription {
  readonly subscriptionId: string;
  readonly serverId: string;
  readonly uri: string;
  readonly projectId: string;
  readonly createdAt: number;
}

/**
 * Secrets-free health snapshot for a server. Never carries env values,
 * headers, or resolved secrets — only counts and capability flags.
 */
export interface McpServerHealth {
  readonly serverId: string;
  readonly name: string;
  readonly transport: string;
  readonly state: McpConnectionState;
  readonly capabilities: DiscoveredCapabilities;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly subscriptionCount: number;
  readonly lastConnectedAt?: string;
  readonly lastFailure?: string;
}

export interface MCPHostEvents {
  onToolsChanged?: (serverId: string, tools: readonly ToolDefinition[]) => void;
  onStateChanged?: (serverId: string, state: McpConnectionState, error?: string) => void;
  /** PR38: fired after capability discovery and on list_changed resyncs. */
  onCapabilitiesChanged?: (serverId: string, capabilities: DiscoveredCapabilities) => void;
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

  /**
   * Lists discovered resource descriptors for a server (or all servers).
   * Returns [] for unknown or disconnected servers.
   */
  listResources(serverId?: string): Promise<readonly McpResourceInfo[]>;

  /**
   * Reads a resource by URI. The URI must match a discovered resource or
   * resource template; dangerous schemes and over-long URIs are rejected.
   * Payloads are truncated to the 256 KB ceiling (truncated: true).
   */
  readResource(
    serverId: string,
    uri: string,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<McpResourceContent>;

  /**
   * Lists discovered prompt descriptors for a server (or all servers).
   */
  listPrompts(serverId?: string): Promise<readonly McpPromptInfo[]>;

  /**
   * Renders a discovered prompt. Returns raw normalized messages plus the
   * framed:true marker; content framing happens at the ai-core boundary.
   */
  getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, unknown>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<McpPromptResult>;

  /**
   * Subscribes to resource updates. Requires the server to advertise the
   * subscriptions capability. Capped per project; entries expire after
   * MCP_SUBSCRIPTION_TTL_MS and are cleared on disconnect.
   */
  subscribe(
    serverId: string,
    uri: string,
    projectId: string,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<McpSubscription>;

  /**
   * Removes a subscription. Idempotent: unknown IDs are a safe no-op.
   */
  unsubscribe(subscriptionId: string): Promise<void>;

  /**
   * Returns a secrets-free health snapshot, or undefined for unknown servers.
   */
  getHealth(serverId: string): McpServerHealth | undefined;
}
