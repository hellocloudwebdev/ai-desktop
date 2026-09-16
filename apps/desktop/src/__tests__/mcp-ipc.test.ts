// PR38: apps/desktop — MCP IPC Channel & Dispatch Tests
//
// Invariants tested:
//   1. All mcp:* channels registered (11 commands).
//   2. NO mcp:execute channel exists (arbitrary IPC execution forbidden).
//   3. Schema validation rejects malformed inputs before handlers run.
//   4. Host dispatch works; missing host fails closed.

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { MCPHost } from "@ai-desktop/mcp";

function createMockMcpHost() {
  return {
    listServers: vi.fn().mockReturnValue([]),
    getServerStatus: vi.fn().mockReturnValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getHealth: vi.fn().mockReturnValue(undefined),
    listResources: vi.fn().mockResolvedValue([]),
    readResource: vi.fn().mockResolvedValue({ uri: "doc://a", text: "hello" }),
    listPrompts: vi.fn().mockResolvedValue([]),
    getPrompt: vi.fn().mockResolvedValue({ messages: [], framed: true }),
    subscribe: vi.fn().mockResolvedValue({ subscriptionId: "sub-1" }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };
}

describe("mcp ipc channels", () => {
  it("registers all eleven MCP channels", () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {
      mcpHost: createMockMcpHost() as unknown as MCPHost,
    });
    for (const channel of [
      IPC_CHANNELS.MCP_SERVER_LIST,
      IPC_CHANNELS.MCP_SERVER_GET,
      IPC_CHANNELS.MCP_SERVER_CONNECT,
      IPC_CHANNELS.MCP_SERVER_DISCONNECT,
      IPC_CHANNELS.MCP_CAPABILITIES,
      IPC_CHANNELS.MCP_RESOURCES,
      IPC_CHANNELS.MCP_RESOURCE_READ,
      IPC_CHANNELS.MCP_PROMPTS,
      IPC_CHANNELS.MCP_PROMPT_GET,
      IPC_CHANNELS.MCP_SUBSCRIBE,
      IPC_CHANNELS.MCP_UNSUBSCRIBE,
    ]) {
      expect(registry.registeredChannels.has(channel)).toBe(true);
    }
  });

  it("exposes no mcp:execute channel", () => {
    expect(Object.values(IPC_CHANNELS)).not.toContain("mcp:execute");
  });

  it("rejects empty serverId before the handler runs", async () => {
    const host = createMockMcpHost();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { mcpHost: host as unknown as MCPHost });
    const res = await registry.invokeCommand(IPC_CHANNELS.MCP_SERVER_GET, { serverId: "" });
    expect(res.ok).toBe(false);
    expect(host.getServerStatus).not.toHaveBeenCalled();
  });

  it("rejects resource read without projectId", async () => {
    const host = createMockMcpHost();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { mcpHost: host as unknown as MCPHost });
    const res = await registry.invokeCommand(IPC_CHANNELS.MCP_RESOURCE_READ, {
      serverId: "srv",
      uri: "doc://guide",
    });
    expect(res.ok).toBe(false);
    expect(host.readResource).not.toHaveBeenCalled();
  });

  it("dispatches resource read to the host", async () => {
    const host = createMockMcpHost();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { mcpHost: host as unknown as MCPHost });
    const res = await registry.invokeCommand<{ content: { text: string } }>(
      IPC_CHANNELS.MCP_RESOURCE_READ,
      { serverId: "srv", uri: "doc://guide", projectId: "p1" },
    );
    expect(res.ok).toBe(true);
    expect(host.readResource).toHaveBeenCalledWith("srv", "doc://guide");
  });

  it("dispatches subscribe with project scope", async () => {
    const host = createMockMcpHost();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { mcpHost: host as unknown as MCPHost });
    const res = await registry.invokeCommand(IPC_CHANNELS.MCP_SUBSCRIBE, {
      serverId: "srv",
      uri: "doc://guide",
      projectId: "p1",
    });
    expect(res.ok).toBe(true);
    expect(host.subscribe).toHaveBeenCalledWith("srv", "doc://guide", "p1");
  });

  it("fails closed without an MCP host", async () => {
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, {});
    const res = await registry.invokeCommand(IPC_CHANNELS.MCP_SERVER_LIST, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.value as { servers: unknown[] }).servers).toEqual([]);
    }
  });
});
