// PR25.5 & PR25.6 + PR38: packages/mcp — InProcessMCPHost Implementation
//
// Invariants:
//   1. In-process MCP host managing Client and Transport sessions.
//   2. State machine: disconnected -> connecting -> connected -> disconnecting -> failed.
//   3. Discovered tools converted strictly to canonical ToolDefinition (source: mcp, runtime: mcp_protocol).
//   4. Listens for tools/list_changed notification and resyncs tool definitions dynamically.
//   5. Cooperative AbortSignal cancellation forwarded to client.callTool.
//   6. Idempotent connect/disconnect calls.
//   7. PR38: after connect, runs CapabilityDiscovery and syncs resources +
//      prompts when advertised (bounded); resyncs on resources/prompts
//      list_changed; exposes readResource/getPrompt/subscribe with ceilings.
//   8. PR38: secretRef env entries ({ secretRef } objects) resolve via an
//      injected SecretStore; stdio children inherit ONLY an allowlisted
//      slice of process.env plus resolved config env (never the full env).
//   9. SDK types never escape: the host adapts the real Client to the
//      McpClientLike structural surface; tests inject fakes (no processes).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { generateUlid } from "@ai-desktop/shared";
import {
  MCP_MAX_PROMPTS_PER_SERVER,
  MCP_MAX_RESOURCES_PER_SERVER,
  MCP_MAX_RESULT_BYTES,
  MCP_MAX_SUBSCRIPTIONS_PER_PROJECT,
  MCP_SUBSCRIPTION_TTL_MS,
  validateResourceTemplateUri,
  type ToolDefinition,
  type ToolResult,
} from "@ai-desktop/ai-core";
import type { SecretStore } from "@ai-desktop/storage";
import { parseSecretRef } from "@ai-desktop/storage";
import {
  McpServerConfigSchema,
  isMcpEnvSecretRef,
  type McpServerConfig,
} from "./mcp-server-config.js";
import {
  CapabilityDiscovery,
  EMPTY_CAPABILITIES,
  type CapabilityDiscoveryClient,
  type DiscoveredCapabilities,
} from "./mcp-capability-discovery.js";
import {
  convertMcpCallResultToToolResult,
  convertMcpToolToDefinition,
  parseCanonicalToolId,
  toCanonicalToolId,
  type McpRawTool,
} from "./tool-converter.js";
import type {
  MCPHost,
  MCPHostEvents,
  McpConnectionState,
  McpPromptInfo,
  McpPromptResult,
  McpResourceContent,
  McpResourceInfo,
  McpResourceTemplateInfo,
  McpServerHealth,
  McpServerInfo,
  McpSubscription,
} from "./mcp-host.js";

/** Notification method names (single source of truth for resync wiring). */
export const MCP_NOTIFICATION_METHODS = {
  toolsChanged: "notifications/tools/list_changed",
  resourcesChanged: "notifications/resources/list_changed",
  promptsChanged: "notifications/prompts/list_changed",
} as const;

/**
 * Structural client surface the host operates on. Members use method
 * shorthand (bivariant params) so the real SDK Client satisfies it via the
 * default adapter below; tests inject FakeClient objects with the same
 * shape — deterministic, no child processes, no SDK imports in tests.
 */
export interface McpClientLike extends CapabilityDiscoveryClient {
  connect(transport: unknown, options?: { signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
  setNotificationHandler(
    schema: unknown,
    handler: (notification: unknown) => void | Promise<void>,
  ): void;
  callTool(params: unknown, schema?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  listTools?(...args: never[]): Promise<unknown>;
  listResources?(...args: never[]): Promise<unknown>;
  listPrompts?(...args: never[]): Promise<unknown>;
  listResourceTemplates(options?: { signal?: AbortSignal }): Promise<unknown>;
  readResource(params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  getPrompt(params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  subscribeResource(params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  unsubscribeResource(params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export type McpClientFactory = (config: McpServerConfig) => McpClientLike;

export interface InProcessMCPHostDeps {
  readonly secretStore?: SecretStore;
  readonly clientFactory?: McpClientFactory;
}

interface ActiveServerSession {
  readonly config: McpServerConfig;
  readonly client: McpClientLike;
  state: McpConnectionState;
  tools: Map<string, ToolDefinition>; // keyed by canonical tool ID: mcp:<serverId>/<toolName>
  capabilities: DiscoveredCapabilities;
  resources: Map<string, McpResourceInfo>; // keyed by uri
  resourceTemplates: McpResourceTemplateInfo[];
  prompts: Map<string, McpPromptInfo>; // keyed by prompt name
  subscriptions: Map<string, McpSubscription>; // keyed by subscriptionId
  lastConnectedAt?: string;
  error?: string;
}

/**
 * Stdio environment allowlist: child processes inherit ONLY these
 * process.env entries (when present) plus the resolved config env.
 * Everything else — including ambient secrets — is never inherited.
 */
const STDIO_ENV_ALLOWLIST = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
]);

const MAX_RESOURCE_URI_LENGTH = 2000;
const MAX_PROMPT_MESSAGES = 32;
const MAX_PROMPT_CONTENT_CHARS = 8000;
const DANGEROUS_URI_SCHEMES = new Set(["javascript", "vbscript", "data", "file", "blob"]);

function uriScheme(value: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/** Default factory: adapts the real SDK Client to McpClientLike. */
function createDefaultClient(): McpClientLike {
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
  return {
    connect: (transport, options) =>
      client.connect(
        transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
        options,
      ),
    close: () => client.close(),
    getServerCapabilities: () => client.getServerCapabilities(),
    setNotificationHandler: (schema, handler) =>
      client.setNotificationHandler(
        schema as Parameters<typeof client.setNotificationHandler>[0],
        handler as Parameters<typeof client.setNotificationHandler>[1],
      ),
    callTool: (params, schema, options) =>
      client.callTool(
        params as Parameters<typeof client.callTool>[0],
        (schema ?? CallToolResultSchema) as Parameters<typeof client.callTool>[1],
        options,
      ),
    listTools: (options) => client.listTools(undefined, options),
    listResources: (options) => client.listResources(undefined, options),
    listResourceTemplates: (options) => client.listResourceTemplates(undefined, options),
    readResource: (params, options) =>
      client.readResource(params as Parameters<typeof client.readResource>[0], options),
    listPrompts: (options) => client.listPrompts(undefined, options),
    getPrompt: (params, options) =>
      client.getPrompt(params as Parameters<typeof client.getPrompt>[0], options),
    subscribeResource: (params, options) =>
      client.subscribeResource(params as Parameters<typeof client.subscribeResource>[0], options),
    unsubscribeResource: (params, options) =>
      client.unsubscribeResource(
        params as Parameters<typeof client.unsubscribeResource>[0],
        options,
      ),
  };
}

export class InProcessMCPHost implements MCPHost {
  private readonly _sessions = new Map<string, ActiveServerSession>();
  private readonly _events?: MCPHostEvents;
  private readonly _secretStore?: SecretStore;
  private readonly _clientFactory: McpClientFactory;

  constructor(events?: MCPHostEvents, deps?: InProcessMCPHostDeps) {
    this._events = events;
    this._secretStore = deps?.secretStore;
    this._clientFactory = deps?.clientFactory ?? createDefaultClient;
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

    const client = this._clientFactory(validatedConfig);

    const session: ActiveServerSession = {
      config: validatedConfig,
      client,
      state: "connecting",
      tools: new Map(),
      capabilities: { ...EMPTY_CAPABILITIES },
      resources: new Map(),
      resourceTemplates: [],
      prompts: new Map(),
      subscriptions: new Map(),
    };
    this._sessions.set(validatedConfig.id, session);
    this._updateState(validatedConfig.id, "connecting");

    try {
      let transport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport | unknown;

      if (validatedConfig.transport === "stdio") {
        // PR38: never inherit the full parent env — allowlist + resolved config env only.
        const envRecord: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined && STDIO_ENV_ALLOWLIST.has(k)) {
            envRecord[k] = v;
          }
        }
        const resolvedEnv = await this._resolveEnv(validatedConfig);
        for (const [k, v] of Object.entries(resolvedEnv)) {
          envRecord[k] = v;
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
      } else if (validatedConfig.transport === "streamable-http") {
        transport = new StreamableHTTPClientTransport(new URL(validatedConfig.url!));
      } else if (validatedConfig.transport === "in_memory") {
        // In-memory transport: either given a pre-created transport or created via pair
        if (validatedConfig.inMemoryServer instanceof InMemoryTransport) {
          transport = validatedConfig.inMemoryServer;
        } else if (this._clientFactory !== createDefaultClient) {
          // Custom client factory (e.g. FakeClient in tests): the transport
          // object is never used by the injected client, so any placeholder
          // value is accepted here. The default factory stays strict.
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

      // Setup list_changed handlers BEFORE connecting
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this._syncTools(validatedConfig.id);
      });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        await this._syncResources(validatedConfig.id);
      });
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        await this._syncPrompts(validatedConfig.id);
      });

      // Connect to server
      await client.connect(transport);

      // Perform initial tool discovery (preserved PR25 behavior: always sync tools)
      await this._syncTools(validatedConfig.id);

      // PR38: capability discovery, then bounded category syncs
      session.capabilities = await CapabilityDiscovery.discover(client);
      if (session.capabilities.resources) {
        await this._syncResources(validatedConfig.id);
      }
      if (session.capabilities.prompts) {
        await this._syncPrompts(validatedConfig.id);
      }
      this._events?.onCapabilitiesChanged?.(validatedConfig.id, session.capabilities);

      session.state = "connected";
      session.lastConnectedAt = new Date().toISOString();
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
   * Disconnects from an active server. Idempotent. Clears tools and
   * subscriptions for that server.
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
      session.resources.clear();
      session.resourceTemplates = [];
      session.prompts.clear();
      session.subscriptions.clear();
      session.capabilities = { ...EMPTY_CAPABILITIES };
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

  /**
   * Lists discovered resources for a server (or all connected servers).
   */
  async listResources(serverId?: string): Promise<readonly McpResourceInfo[]> {
    const sessions = this._connectedSessions(serverId);
    const out: McpResourceInfo[] = [];
    for (const session of sessions) {
      out.push(...session.resources.values());
    }
    return out;
  }

  /**
   * Reads a resource by URI with validation and a 256 KB ceiling.
   */
  async readResource(
    serverId: string,
    uri: string,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<McpResourceContent> {
    const session = this._requireConnected(serverId);
    this._assertReadableUri(session, uri);

    let raw: unknown;
    try {
      raw = await session.client.readResource({ uri }, { signal: opts?.signal });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read resource "${uri}" from server "${serverId}": ${errMsg}`);
    }

    const contents = (raw as { contents?: unknown })?.contents;
    if (!Array.isArray(contents) || contents.length === 0) {
      throw new Error(`Resource "${uri}" returned no content`);
    }

    const texts: string[] = [];
    let mimeType: string | undefined;
    let blobBase64: string | undefined;
    for (const block of contents as Array<{
      uri?: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }>) {
      if (typeof block?.mimeType === "string" && mimeType === undefined) {
        mimeType = block.mimeType;
      }
      if (typeof block?.text === "string") {
        texts.push(block.text);
      } else if (typeof block?.blob === "string" && blobBase64 === undefined) {
        blobBase64 = block.blob;
      }
    }

    if (texts.length > 0) {
      const joined = texts.join("\n");
      const bytes = Buffer.byteLength(joined, "utf8");
      if (bytes > MCP_MAX_RESULT_BYTES) {
        const truncated = Buffer.from(joined, "utf8")
          .subarray(0, MCP_MAX_RESULT_BYTES)
          .toString("utf8");
        return { uri, mimeType, text: truncated, truncated: true };
      }
      return { uri, mimeType, text: joined };
    }

    if (blobBase64 !== undefined) {
      if (blobBase64.length > MCP_MAX_RESULT_BYTES) {
        return {
          uri,
          mimeType,
          blobBase64: blobBase64.slice(0, MCP_MAX_RESULT_BYTES),
          truncated: true,
        };
      }
      return { uri, mimeType, blobBase64 };
    }

    throw new Error(`Resource "${uri}" returned content without text or blob`);
  }

  /**
   * Lists discovered prompts for a server (or all connected servers).
   */
  async listPrompts(serverId?: string): Promise<readonly McpPromptInfo[]> {
    const sessions = this._connectedSessions(serverId);
    const out: McpPromptInfo[] = [];
    for (const session of sessions) {
      out.push(...session.prompts.values());
    }
    return out;
  }

  /**
   * Renders a discovered prompt. Returns raw normalized messages plus the
   * framed:true marker — framing is applied at the ai-core boundary.
   */
  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, unknown>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<McpPromptResult> {
    const session = this._requireConnected(serverId);
    if (!session.prompts.has(name)) {
      throw new Error(`Prompt "${name}" is not available on server "${serverId}"`);
    }

    let raw: unknown;
    try {
      raw = await session.client.getPrompt({ name, arguments: args }, { signal: opts?.signal });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to get prompt "${name}" from server "${serverId}": ${errMsg}`);
    }

    const messages = (raw as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) {
      throw new Error(`Prompt "${name}" returned no messages`);
    }

    const normalized = messages.slice(0, MAX_PROMPT_MESSAGES).map((m) => {
      const msg = m as { role?: unknown; content?: unknown };
      const role = msg?.role === "assistant" ? "assistant" : "user";
      const content = msg?.content;
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (
        content !== null &&
        typeof content === "object" &&
        typeof (content as { text?: unknown }).text === "string"
      ) {
        text = (content as { text: string }).text;
      } else {
        text = JSON.stringify(content ?? "");
      }
      if (text.length > MAX_PROMPT_CONTENT_CHARS) {
        text = `${text.slice(0, MAX_PROMPT_CONTENT_CHARS)}\n[Prompt content truncated]`;
      }
      return { role: role as "user" | "assistant", content: text };
    });

    return { messages: normalized, framed: true as const };
  }

  /**
   * Subscribes to resource updates for a project.
   */
  async subscribe(
    serverId: string,
    uri: string,
    projectId: string,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<McpSubscription> {
    const session = this._requireConnected(serverId);
    if (!session.capabilities.subscriptions) {
      throw new Error(`Server "${serverId}" does not advertise the subscriptions capability`);
    }
    this._assertReadableUri(session, uri);
    if (!projectId || projectId.trim().length === 0) {
      throw new Error("subscribe requires a non-empty projectId");
    }

    this._pruneExpiredSubscriptions(session);
    const projectCount = [...session.subscriptions.values()].filter(
      (s) => s.projectId === projectId,
    ).length;
    if (projectCount >= MCP_MAX_SUBSCRIPTIONS_PER_PROJECT) {
      throw new Error(
        `Subscription limit reached for project (${MCP_MAX_SUBSCRIPTIONS_PER_PROJECT})`,
      );
    }

    try {
      await session.client.subscribeResource({ uri }, { signal: opts?.signal });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to subscribe to "${uri}" on server "${serverId}": ${errMsg}`);
    }

    const subscription: McpSubscription = {
      subscriptionId: generateUlid(),
      serverId,
      uri,
      projectId,
      createdAt: Date.now(),
    };
    session.subscriptions.set(subscription.subscriptionId, subscription);
    return subscription;
  }

  /**
   * Removes a subscription. Idempotent.
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    for (const session of this._sessions.values()) {
      const sub = session.subscriptions.get(subscriptionId);
      if (!sub) continue;
      try {
        await session.client.unsubscribeResource({ uri: sub.uri });
      } catch {
        // Best-effort: drop the record even if the server call fails
      }
      session.subscriptions.delete(subscriptionId);
      return;
    }
  }

  /**
   * Secrets-free health snapshot (counts + flags only, never env/secrets).
   */
  getHealth(serverId: string): McpServerHealth | undefined {
    const session = this._sessions.get(serverId);
    if (!session) return undefined;
    this._pruneExpiredSubscriptions(session);
    return {
      serverId: session.config.id,
      name: session.config.name,
      transport: session.config.transport,
      state: session.state,
      capabilities: { ...session.capabilities },
      toolCount: session.tools.size,
      resourceCount: session.resources.size,
      promptCount: session.prompts.size,
      subscriptionCount: session.subscriptions.size,
      lastConnectedAt: session.lastConnectedAt,
      lastFailure: session.error,
    };
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
   * Resolves config env: literal strings pass through; { secretRef } objects
   * resolve via the injected SecretStore. Errors name the variable and the
   * (non-secret) reference only — resolved values never appear in errors.
   */
  private async _resolveEnv(config: McpServerConfig): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    const env = config.env as Record<string, string | { secretRef: string }> | undefined;
    if (!env) return resolved;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        resolved[key] = value;
        continue;
      }
      if (isMcpEnvSecretRef(value)) {
        if (!this._secretStore) {
          throw new Error(
            `Env "${key}" requires secretRef resolution but no SecretStore is configured`,
          );
        }
        let ref;
        try {
          ref = parseSecretRef(value.secretRef);
        } catch {
          throw new Error(`Env "${key}" has an invalid secretRef "${value.secretRef}"`);
        }
        const secret = await this._secretStore.get(ref);
        if (secret === null) {
          throw new Error(`Env "${key}" references missing secret "${value.secretRef}"`);
        }
        resolved[key] = secret;
        continue;
      }
      throw new Error(`Env "${key}" has an unsupported value shape`);
    }
    return resolved;
  }

  private _requireConnected(serverId: string): ActiveServerSession {
    const session = this._sessions.get(serverId);
    if (!session) {
      throw new Error(`MCP server "${serverId}" is not configured`);
    }
    if (session.state !== "connected") {
      throw new Error(`MCP server "${serverId}" is not connected (state: ${session.state})`);
    }
    return session;
  }

  private _connectedSessions(serverId?: string): ActiveServerSession[] {
    if (serverId) {
      const session = this._sessions.get(serverId);
      return session && session.state === "connected" ? [session] : [];
    }
    return [...this._sessions.values()].filter((s) => s.state === "connected");
  }

  /**
   * URI gate for readResource/subscribe: length cap, dangerous schemes
   * rejected, and the URI must match a discovered resource or template
   * (ai-core template matcher). Never throws for control-flow — throws only
   * descriptive validation errors naming the URI, never content.
   */
  private _assertReadableUri(session: ActiveServerSession, uri: string): void {
    if (typeof uri !== "string" || uri.length === 0 || uri.length > MAX_RESOURCE_URI_LENGTH) {
      throw new Error(`Invalid resource URI (must be 1-${MAX_RESOURCE_URI_LENGTH} chars)`);
    }
    const scheme = uriScheme(uri);
    if (scheme !== null && DANGEROUS_URI_SCHEMES.has(scheme)) {
      throw new Error(`Resource URI scheme "${scheme}:" is not allowed`);
    }
    if (session.resources.has(uri)) {
      return;
    }
    const templateMatch = session.resourceTemplates.some((t) =>
      validateResourceTemplateUri(t.uriTemplate, uri),
    );
    if (!templateMatch) {
      throw new Error(`Resource URI is not provided by this server`);
    }
  }

  private _pruneExpiredSubscriptions(session: ActiveServerSession): void {
    const now = Date.now();
    for (const [id, sub] of session.subscriptions) {
      if (now - sub.createdAt > MCP_SUBSCRIPTION_TTL_MS) {
        session.subscriptions.delete(id);
      }
    }
  }

  /**
   * Synchronizes tools from an MCP server and detects changes/removals.
   */
  private async _syncTools(serverId: string): Promise<void> {
    const session = this._sessions.get(serverId);
    if (!session) return;

    try {
      // listTools is optional on McpClientLike (partial fakes); a missing
      // probe method means "unsupported", not an error.
      const res = (await session.client.listTools?.()) as { tools?: McpRawTool[] } | undefined;
      const rawTools = res?.tools ?? [];

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

  /**
   * Synchronizes resources + templates (bounded). Emits capabilities event.
   */
  private async _syncResources(serverId: string): Promise<void> {
    const session = this._sessions.get(serverId);
    if (!session) return;
    if (!session.capabilities.resources && session.state === "connected") {
      return;
    }

    try {
      const res = (await session.client.listResources?.()) as
        | {
            resources?: Array<{
              uri?: unknown;
              name?: unknown;
              description?: unknown;
              mimeType?: unknown;
            }>;
          }
        | undefined;
      const updated = new Map<string, McpResourceInfo>();
      for (const raw of (res?.resources ?? []).slice(0, MCP_MAX_RESOURCES_PER_SERVER)) {
        if (typeof raw?.uri !== "string" || typeof raw?.name !== "string") continue;
        if (raw.uri.length === 0 || raw.uri.length > MAX_RESOURCE_URI_LENGTH) continue;
        updated.set(raw.uri, {
          uri: raw.uri,
          name: raw.name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
        });
      }
      session.resources = updated;

      try {
        const templates = (await session.client.listResourceTemplates()) as {
          resourceTemplates?: Array<{ uriTemplate?: unknown; name?: unknown }>;
        };
        session.resourceTemplates = (templates.resourceTemplates ?? [])
          .slice(0, MCP_MAX_RESOURCES_PER_SERVER)
          .filter(
            (t): t is McpResourceTemplateInfo =>
              typeof t?.uriTemplate === "string" && typeof t?.name === "string",
          )
          .map((t) => ({ uriTemplate: t.uriTemplate, name: t.name }));
      } catch {
        session.resourceTemplates = [];
      }

      this._events?.onCapabilitiesChanged?.(serverId, session.capabilities);
    } catch (err) {
      console.warn(`[InProcessMCPHost] Failed to sync resources for server "${serverId}":`, err);
    }
  }

  /**
   * Synchronizes prompts (bounded). Emits capabilities event.
   */
  private async _syncPrompts(serverId: string): Promise<void> {
    const session = this._sessions.get(serverId);
    if (!session) return;
    if (!session.capabilities.prompts && session.state === "connected") {
      return;
    }

    try {
      const res = (await session.client.listPrompts?.()) as
        | {
            prompts?: Array<{
              name?: unknown;
              description?: unknown;
              arguments?: unknown;
            }>;
          }
        | undefined;
      const updated = new Map<string, McpPromptInfo>();
      for (const raw of (res?.prompts ?? []).slice(0, MCP_MAX_PROMPTS_PER_SERVER)) {
        if (typeof raw?.name !== "string") continue;
        const args = Array.isArray(raw.arguments)
          ? raw.arguments
              .filter(
                (a): a is { name: string; required?: boolean } =>
                  !!a && typeof (a as { name?: unknown }).name === "string",
              )
              .map((a) => ({ name: a.name, required: a.required }))
          : undefined;
        updated.set(raw.name, {
          name: raw.name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          arguments: args,
        });
      }
      session.prompts = updated;
      this._events?.onCapabilitiesChanged?.(serverId, session.capabilities);
    } catch (err) {
      console.warn(`[InProcessMCPHost] Failed to sync prompts for server "${serverId}":`, err);
    }
  }

  private _updateState(serverId: string, state: McpConnectionState, error?: string): void {
    this._events?.onStateChanged?.(serverId, state, error);
  }
}
