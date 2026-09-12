// PR25.5 & PR25.6: packages/mcp — InProcessMCPHost Implementation
//
// Invariants:
//   1. In-process MCP host managing Client and Transport sessions.
//   2. State machine: disconnected -> connecting -> connected -> disconnecting -> failed.
//   3. Discovered tools converted strictly to canonical ToolDefinition (source: mcp, runtime: mcp_protocol).
//   4. Listens for tools/list_changed notification and resyncs tool definitions dynamically.
//   5. Cooperative AbortSignal cancellation forwarded to client.callTool.
//   6. Idempotent connect/disconnect calls.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, ToolResult } from "@ai-desktop/ai-core";
import { McpServerConfigSchema, type McpServerConfig } from "./mcp-server-config.js";
import {
  convertMcpCallResultToToolResult,
  convertMcpToolToDefinition,
  parseCanonicalToolId,
  toCanonicalToolId,
  type McpRawTool,
} from "./tool-converter.js";
import type { MCPHost, MCPHostEvents, McpConnectionState, McpServerInfo } from "./mcp-host.js";

interface ActiveServerSession {
  readonly config: McpServerConfig;
  readonly client: Client;
  state: McpConnectionState;
  tools: Map<string, ToolDefinition>; // keyed by canonical tool ID: mcp:<serverId>/<toolName>
  error?: string;
}

export class InProcessMCPHost implements MCPHost {
  private readonly _sessions = new Map<string, ActiveServerSession>();
  private readonly _events?: MCPHostEvents;

  constructor(events?: MCPHostEvents) {
    this._events = events;
  }

  /**
   * Connects to an MCP server. Idempotent if already connected.
   */
  async connect(config: McpServerConfig): Promise<void> {
    const validatedConfig = McpServerConfigSchema.parse(config);
    const existing = this._sessions.get(validatedConfig.id);

    if (existing && existing.state === "connected") {
      return; // Already connected
    }

    const client = new Client(
      {
        name: "ai-desktop",
        version: "1.0.0",
      },
      {
        capabilities: {
          roots: { listChanged: true },
        },
      },
    );

    const session: ActiveServerSession = {
      config: validatedConfig,
      client,
      state: "connecting",
      tools: new Map(),
    };
    this._sessions.set(validatedConfig.id, session);
    this._updateState(validatedConfig.id, "connecting");

    try {
      let transport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport;

      if (validatedConfig.transport === "stdio") {
        const envRecord: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) {
            envRecord[k] = v;
          }
        }
        if (validatedConfig.env) {
          for (const [k, v] of Object.entries(validatedConfig.env)) {
            envRecord[k] = v;
          }
        }

        transport = new StdioClientTransport({
          command: validatedConfig.command!,
          args: validatedConfig.args,
          env: envRecord,
          cwd: validatedConfig.cwd,
        });
      } else if (validatedConfig.transport === "sse") {
        transport = new SSEClientTransport(new URL(validatedConfig.url!), {
          requestInit: validatedConfig.headers ? { headers: validatedConfig.headers } : undefined,
        });
      } else if (validatedConfig.transport === "in_memory") {
        // In-memory transport: either given a pre-created transport or created via pair
        if (validatedConfig.inMemoryServer instanceof InMemoryTransport) {
          transport = validatedConfig.inMemoryServer;
        } else {
          throw new Error(
            "in_memory transport requires an InMemoryTransport instance in inMemoryServer",
          );
        }
      } else {
        throw new Error(
          `Unsupported transport type: ${(validatedConfig as { transport: string }).transport}`,
        );
      }

      // Setup list_changed handler BEFORE connecting
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this._syncTools(validatedConfig.id);
      });

      // Connect to server
      await client.connect(transport);

      // Perform initial tool discovery
      await this._syncTools(validatedConfig.id);

      session.state = "connected";
      this._updateState(validatedConfig.id, "connected");
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      session.state = "failed";
      session.error = errMsg;
      this._updateState(validatedConfig.id, "failed", errMsg);
      throw new Error(`Failed to connect to MCP server "${validatedConfig.id}": ${errMsg}`);
    }
  }

  /**
   * Disconnects from an active server. Idempotent.
   */
  async disconnect(serverId: string): Promise<void> {
    const session = this._sessions.get(serverId);
    if (!session) {
      return; // Safe on unknown server
    }

    if (session.state === "disconnected") {
      return;
    }

    session.state = "disconnecting";
    this._updateState(serverId, "disconnecting");

    try {
      await session.client.close();
    } catch {
      // Best-effort cleanup
    } finally {
      session.state = "disconnected";
      session.tools.clear();
      this._updateState(serverId, "disconnected");
    }
  }

  /**
   * Lists discovered tools for a specific server or all connected servers.
   */
  async listTools(serverId?: string): Promise<readonly ToolDefinition[]> {
    if (serverId) {
      const session = this._sessions.get(serverId);
      if (!session || session.state !== "connected") {
        return [];
      }
      return [...session.tools.values()];
    }

    const allTools: ToolDefinition[] = [];
    for (const session of this._sessions.values()) {
      if (session.state === "connected") {
        allTools.push(...session.tools.values());
      }
    }
    return allTools;
  }

  /**
   * Calls a tool on a connected MCP server.
   */
  async callTool(
    serverId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const session = this._sessions.get(serverId);
    if (!session) {
      throw new Error(`MCP server "${serverId}" is not configured`);
    }
    if (session.state !== "connected") {
      throw new Error(`MCP server "${serverId}" is not connected (state: ${session.state})`);
    }

    // Determine raw tool name (e.g. if passed canonical ID mcp:serverId/toolName)
    const parsed = parseCanonicalToolId(toolName);
    const rawToolName = parsed ? parsed.toolName : toolName;
    const canonicalId = toCanonicalToolId(serverId, rawToolName);

    const startTime = Date.now();

    try {
      const rawResult = await session.client.callTool(
        {
          name: rawToolName,
          arguments: (input as Record<string, unknown>) ?? {},
        },
        CallToolResultSchema,
        { signal },
      );

      const durationMs = Date.now() - startTime;
      return convertMcpCallResultToToolResult({
        canonicalToolName: canonicalId,
        mcpResult: rawResult,
        durationMs,
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);

      return {
        toolCallId:
          (input as { toolCallId?: import("@ai-desktop/shared").ToolCallId })?.toolCallId ??
          (toCanonicalToolId as unknown as import("@ai-desktop/shared").ToolCallId),
        toolName: canonicalId,
        result: `MCP tool execution failed: ${errMsg}`,
        isError: true,
        durationMs,
        timestamp: new Date().toISOString() as unknown as import("@ai-desktop/shared").Timestamp,
        metadata: {
          error: errMsg,
        },
      };
    }
  }

  getServerStatus(serverId: string): McpServerInfo | undefined {
    const session = this._sessions.get(serverId);
    if (!session) return undefined;
    return {
      id: session.config.id,
      name: session.config.name,
      state: session.state,
      toolCount: session.tools.size,
      error: session.error,
    };
  }

  listServers(): readonly McpServerInfo[] {
    return [...this._sessions.values()].map((s) => ({
      id: s.config.id,
      name: s.config.name,
      state: s.state,
      toolCount: s.tools.size,
      error: s.error,
    }));
  }

  async close(): Promise<void> {
    const serverIds = [...this._sessions.keys()];
    for (const id of serverIds) {
      await this.disconnect(id);
    }
    this._sessions.clear();
  }

  /**
   * Synchronizes tools from an MCP server and detects changes/removals.
   */
  private async _syncTools(serverId: string): Promise<void> {
    const session = this._sessions.get(serverId);
    if (!session) return;

    try {
      const res = await session.client.listTools();
      const rawTools = (res.tools ?? []) as McpRawTool[];

      const updatedTools = new Map<string, ToolDefinition>();
      for (const raw of rawTools) {
        const canonical = convertMcpToolToDefinition(serverId, raw);
        updatedTools.set(canonical.name, canonical);
      }

      session.tools = updatedTools;
      this._events?.onToolsChanged?.(serverId, [...updatedTools.values()]);
    } catch (err) {
      console.warn(`[InProcessMCPHost] Failed to sync tools for server "${serverId}":`, err);
    }
  }

  private _updateState(serverId: string, state: McpConnectionState, error?: string): void {
    this._events?.onStateChanged?.(serverId, state, error);
  }
}
