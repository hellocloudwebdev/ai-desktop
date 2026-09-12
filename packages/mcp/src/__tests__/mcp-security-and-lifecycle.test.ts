import { describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DefaultPermissionManager } from "@ai-desktop/permissions";
import { createToolCallId, ValidationError } from "@ai-desktop/shared";
import { InProcessMCPHost } from "../core/in-process-mcp-host.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { McpToolExecutor, MAX_RESULT_BYTES } from "../core/mcp-tool-executor.js";

function setupExecutionHarness() {
  const server = new Server(
    { name: "test-mcp-server", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  let slowToolDelayMs = 0;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_issue",
          description: "Gets issue by ID",
          inputSchema: {
            type: "object",
            properties: { issueId: { type: "number" } },
            required: ["issueId"],
          },
        },
        {
          name: "delete_repo",
          description: "Deletes a repository",
          inputSchema: {
            type: "object",
            properties: { repoName: { type: "string" } },
            required: ["repoName"],
          },
        },
        {
          name: "large_output",
          description: "Returns a very large payload exceeding 256KB",
          inputSchema: { type: "object" },
        },
        {
          name: "slow_tool",
          description: "Delays execution to test timeouts and cancellation",
          inputSchema: { type: "object" },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "get_issue") {
      return {
        content: [
          { type: "text", text: `Issue #${(args as { issueId: number })?.issueId} details` },
        ],
      };
    }
    if (name === "delete_repo") {
      return {
        content: [
          { type: "text", text: `Deleted repo: ${(args as { repoName: string })?.repoName}` },
        ],
      };
    }
    if (name === "large_output") {
      // 300 KB payload exceeding the 256 KB ceiling
      const bigText = "A".repeat(300 * 1024);
      return {
        content: [{ type: "text", text: bigText }],
      };
    }
    if (name === "slow_tool") {
      if (slowToolDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, slowToolDelayMs));
      }
      return {
        content: [{ type: "text", text: "Slow operation completed" }],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  return {
    server,
    clientTransport,
    serverTransport,
    setSlowDelay: (ms: number) => {
      slowToolDelayMs = ms;
    },
  };
}

describe("packages/mcp: Universal Tool Lifecycle, Permissions, and Limits (PR25.9, PR25.10, PR25.13)", () => {
  it("enforces validation -> permission -> execution: validation failure aborts before permission check", async () => {
    const { server, clientTransport, serverTransport } = setupExecutionHarness();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "github",
      name: "GitHub MCP Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const registry = new ToolRegistry();
    const tools = await host.listTools("github");
    for (const t of tools) registry.registerTool(t);

    let permissionChecked = false;
    const permissionManager = new DefaultPermissionManager();
    const originalCheck = permissionManager.check.bind(permissionManager);
    permissionManager.check = async (req, opts) => {
      permissionChecked = true;
      return originalCheck(req, opts);
    };

    const executor = new McpToolExecutor(registry, permissionManager, host);

    // Missing required parameter 'issueId' -> validation fails FIRST
    await expect(executor.execute("mcp:github/get_issue", {})).rejects.toThrow(ValidationError);

    // CRITICAL: Permission check was NEVER called because validation failed first (§PR24.8)
    expect(permissionChecked).toBe(false);

    await host.close();
    await server.close();
  });

  it("permission rejection halts execution before calling MCP backend", async () => {
    const { server, clientTransport, serverTransport } = setupExecutionHarness();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "github",
      name: "GitHub MCP Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const registry = new ToolRegistry();
    const tools = await host.listTools("github");
    for (const t of tools) registry.registerTool(t);

    const permissionManager = new DefaultPermissionManager();
    const executor = new McpToolExecutor(registry, permissionManager, host);

    // Initial call without prior approval -> halts at requires_user
    const result = await executor.execute("mcp:github/get_issue", { issueId: 101 });
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Permission denied: Requires user permission");

    await host.close();
    await server.close();
  });

  it("approving get_issue does NOT authorize delete_repo (strict per-tool MCP isolation)", async () => {
    const { server, clientTransport, serverTransport } = setupExecutionHarness();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "github",
      name: "GitHub MCP Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const registry = new ToolRegistry();
    const tools = await host.listTools("github");
    for (const t of tools) registry.registerTool(t);

    const permissionManager = new DefaultPermissionManager();
    const executor = new McpToolExecutor(registry, permissionManager, host);

    // 1. Check get_issue -> requires_user -> approve for session
    const getIssueCheck = await permissionManager.check({
      capability: "mcp",
      action: "call",
      resource: "mcp:github/get_issue",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [
        createToolCallId() as unknown as import("@ai-desktop/shared").ToolCallId,
      ],
    });

    if (getIssueCheck.kind === "requires_user") {
      await permissionManager.resolve({
        requestId: getIssueCheck.request.id,
        decision: "granted",
        mode: "allow_session",
      });
    }

    // 2. get_issue now executes cleanly
    const issueRes = await executor.execute("mcp:github/get_issue", { issueId: 42 });
    expect(issueRes.isError).toBe(false);
    expect(issueRes.result).toContain("Issue #42 details");

    // 3. delete_repo on same server must NOT be approved implicitly!
    const deleteRes = await executor.execute("mcp:github/delete_repo", {
      repoName: "important-repo",
    });
    expect(deleteRes.isError).toBe(true);
    expect(deleteRes.result).toContain("Permission denied");

    await host.close();
    await server.close();
  });

  it("enforces global 256 KB result ceiling at executor boundary", async () => {
    const { server, clientTransport, serverTransport } = setupExecutionHarness();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "data-srv",
      name: "Data Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const registry = new ToolRegistry();
    const tools = await host.listTools("data-srv");
    for (const t of tools) registry.registerTool(t);

    const permissionManager = new DefaultPermissionManager();
    // Grant session approval for large_output
    const check = await permissionManager.check({
      capability: "mcp",
      action: "call",
      resource: "mcp:data-srv/large_output",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [
        createToolCallId() as unknown as import("@ai-desktop/shared").ToolCallId,
      ],
    });
    if (check.kind === "requires_user") {
      await permissionManager.resolve({
        requestId: check.request.id,
        decision: "granted",
        mode: "allow_session",
      });
    }

    const executor = new McpToolExecutor(registry, permissionManager, host);
    const result = await executor.execute("mcp:data-srv/large_output", {});

    // Result was truncated to 256 KB ceiling
    expect(result.result).toContain("[Result exceeded 256KB ceiling; truncated to 262,144 bytes]");
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.originalBytes).toBeGreaterThan(MAX_RESULT_BYTES);

    await host.close();
    await server.close();
  });

  it("terminates execution on hard timeout and fires soft warning", async () => {
    const { server, clientTransport, serverTransport, setSlowDelay } = setupExecutionHarness();
    setSlowDelay(100); // delays tool response by 100ms
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "slow-srv",
      name: "Slow Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const registry = new ToolRegistry();
    const tools = await host.listTools("slow-srv");
    for (const t of tools) registry.registerTool(t);

    const permissionManager = new DefaultPermissionManager();
    const check = await permissionManager.check({
      capability: "mcp",
      action: "call",
      resource: "mcp:slow-srv/slow_tool",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [
        createToolCallId() as unknown as import("@ai-desktop/shared").ToolCallId,
      ],
    });
    if (check.kind === "requires_user") {
      await permissionManager.resolve({
        requestId: check.request.id,
        decision: "granted",
        mode: "allow_session",
      });
    }

    let softWarningFired = false;
    const executor = new McpToolExecutor(registry, permissionManager, host, {
      onSoftTimeout: () => {
        softWarningFired = true;
      },
    });

    // Execute with hard timeout of 40ms (shorter than server delay of 100ms)
    const result = await executor.execute(
      "mcp:slow-srv/slow_tool",
      {},
      {
        softTimeoutMs: 20,
        hardTimeoutMs: 40,
      },
    );

    expect(softWarningFired).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.result).toContain("cancelled");
    expect(result.metadata?.cancelled).toBe(true);

    await host.close();
    await server.close();
  });

  it("cooperative cancellation via AbortSignal terminates execution promptly", async () => {
    const { server, clientTransport, serverTransport, setSlowDelay } = setupExecutionHarness();
    setSlowDelay(200);
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "cancel-srv",
      name: "Cancel Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const registry = new ToolRegistry();
    const tools = await host.listTools("cancel-srv");
    for (const t of tools) registry.registerTool(t);

    const permissionManager = new DefaultPermissionManager();
    const check = await permissionManager.check({
      capability: "mcp",
      action: "call",
      resource: "mcp:cancel-srv/slow_tool",
      scope: "session",
      risk: "low",
      relatedToolCallIds: [
        createToolCallId() as unknown as import("@ai-desktop/shared").ToolCallId,
      ],
    });
    if (check.kind === "requires_user") {
      await permissionManager.resolve({
        requestId: check.request.id,
        decision: "granted",
        mode: "allow_session",
      });
    }

    const executor = new McpToolExecutor(registry, permissionManager, host);
    const abortController = new AbortController();

    // Trigger abort after 30ms
    setTimeout(() => {
      abortController.abort("User cancelled tool call");
    }, 30);

    const result = await executor.execute(
      "mcp:cancel-srv/slow_tool",
      {},
      {
        signal: abortController.signal,
        hardTimeoutMs: 5000,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("cancelled");
    expect(result.metadata?.cancelled).toBe(true);

    await host.close();
    await server.close();
  });
});
