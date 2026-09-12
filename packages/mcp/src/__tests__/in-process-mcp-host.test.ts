import { describe, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InProcessMCPHost } from "../core/in-process-mcp-host.js";

function createMockMcpServer() {
  const server = new Server(
    { name: "mock-mcp-server", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  const availableTools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }> = [
    {
      name: "echo",
      description: "Echoes input text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "add",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: availableTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "echo") {
      return {
        content: [{ type: "text", text: `Echo: ${(args as { text?: string })?.text}` }],
      };
    }
    if (name === "add") {
      const a = Number((args as { a: number })?.a ?? 0);
      const b = Number((args as { b: number })?.b ?? 0);
      return {
        content: [{ type: "text", text: String(a + b) }],
      };
    }
    throw new Error(`Tool not found: ${name}`);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  return {
    server,
    clientTransport,
    serverTransport,
    addTool: async (tool: (typeof availableTools)[0]) => {
      availableTools.push(tool);
      await server.notification({ method: "notifications/tools/list_changed" });
    },
  };
}

describe("packages/mcp: InProcessMCPHost Lifecycle & Execution (PR25.5, PR25.6, PR25.11)", () => {
  it("connects to an MCP server, discovers tools, and sets state to connected", async () => {
    const { server, clientTransport, serverTransport } = createMockMcpServer();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();

    await host.connect({
      id: "test-server",
      name: "Test Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    const status = host.getServerStatus("test-server");
    expect(status?.state).toBe("connected");
    expect(status?.toolCount).toBe(2);

    const tools = await host.listTools("test-server");
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("mcp:test-server/echo");
    expect(tools.map((t) => t.name)).toContain("mcp:test-server/add");

    await host.disconnect("test-server");
    await server.close();
  });

  it("calls a tool and receives canonical ToolResult without leaking SDK structures", async () => {
    const { server, clientTransport, serverTransport } = createMockMcpServer();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    await host.connect({
      id: "math-server",
      name: "Math Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    // Call tool using canonical ID
    const res = await host.callTool("math-server", "mcp:math-server/add", { a: 15, b: 27 });
    expect(res.isError).toBe(false);
    expect(res.result).toBe("42");
    expect(res.toolName).toBe("mcp:math-server/add");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    // Call tool using raw tool name
    const echoRes = await host.callTool("math-server", "echo", { text: "Hello MCP" });
    expect(echoRes.isError).toBe(false);
    expect(echoRes.result).toBe("Echo: Hello MCP");

    await host.close();
    await server.close();
  });

  it("handles tools/list_changed notification dynamically without client restart", async () => {
    const { server, clientTransport, serverTransport, addTool } = createMockMcpServer();
    await server.connect(serverTransport);

    let toolsChangedFired = false;
    const host = new InProcessMCPHost({
      onToolsChanged: (serverId, tools) => {
        if (serverId === "dynamic-srv" && tools.length === 3) {
          toolsChangedFired = true;
        }
      },
    });

    await host.connect({
      id: "dynamic-srv",
      name: "Dynamic Server",
      transport: "in_memory",
      inMemoryServer: clientTransport,
    });

    expect(await host.listTools("dynamic-srv")).toHaveLength(2);

    // Add a new tool on the server and emit list_changed notification
    await addTool({
      name: "multiply",
      description: "Multiplies numbers",
      inputSchema: { type: "object" },
    });

    // Allow async notification to propagate
    await new Promise((r) => setTimeout(r, 50));

    expect(toolsChangedFired).toBe(true);
    const updatedTools = await host.listTools("dynamic-srv");
    expect(updatedTools).toHaveLength(3);
    expect(updatedTools.map((t) => t.name)).toContain("mcp:dynamic-srv/multiply");

    await host.close();
    await server.close();
  });

  it("handles idempotent connect and disconnect gracefully", async () => {
    const { server, clientTransport, serverTransport } = createMockMcpServer();
    await server.connect(serverTransport);

    const host = new InProcessMCPHost();
    const config = {
      id: "idempotent-srv",
      name: "Idempotent Server",
      transport: "in_memory" as const,
      inMemoryServer: clientTransport,
    };

    // 1. Connect
    await host.connect(config);
    expect(host.getServerStatus("idempotent-srv")?.state).toBe("connected");

    // 2. Connect second time -> idempotent safe no-op
    await host.connect(config);
    expect(host.getServerStatus("idempotent-srv")?.state).toBe("connected");

    // 3. Disconnect
    await host.disconnect("idempotent-srv");
    expect(host.getServerStatus("idempotent-srv")?.state).toBe("disconnected");

    // 4. Disconnect second time -> safe no-op
    await host.disconnect("idempotent-srv");
    expect(host.getServerStatus("idempotent-srv")?.state).toBe("disconnected");

    // 5. Disconnect unknown server -> safe no-op
    await host.disconnect("non-existent-server");

    await server.close();
  });

  it("isolates tools between multiple connected MCP servers", async () => {
    const srvA = createMockMcpServer();
    await srvA.server.connect(srvA.serverTransport);

    const srvB = createMockMcpServer();
    await srvB.server.connect(srvB.serverTransport);

    const host = new InProcessMCPHost();

    await host.connect({
      id: "server-A",
      name: "Server A",
      transport: "in_memory",
      inMemoryServer: srvA.clientTransport,
    });

    await host.connect({
      id: "server-B",
      name: "Server B",
      transport: "in_memory",
      inMemoryServer: srvB.clientTransport,
    });

    const toolsA = await host.listTools("server-A");
    const toolsB = await host.listTools("server-B");
    const allTools = await host.listTools();

    expect(toolsA.every((t) => t.name.startsWith("mcp:server-A/"))).toBe(true);
    expect(toolsB.every((t) => t.name.startsWith("mcp:server-B/"))).toBe(true);
    expect(allTools).toHaveLength(4);

    await host.close();
    await srvA.server.close();
    await srvB.server.close();
  });
});
