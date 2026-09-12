import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@ai-desktop/ai-core";
import { ToolRegistry, type ToolDefinitionChange } from "../core/tool-registry.js";
import { convertMcpToolToDefinition } from "../core/tool-converter.js";

describe("packages/mcp: ToolRegistry & Change Detection (PR25.8, PR25.11)", () => {
  it("registers and resolves tools by canonical ID", () => {
    const registry = new ToolRegistry();
    const toolDef: ToolDefinition = {
      name: "mcp:github/get_issue",
      description: "Gets issue by ID",
      source: "mcp",
      runtime: "mcp_protocol",
      parameters: { type: "object" },
    };

    registry.registerTool(toolDef);
    expect(registry.hasTool("mcp:github/get_issue")).toBe(true);
    expect(registry.resolve("mcp:github/get_issue")).toEqual(toolDef);
    expect(registry.listTools()).toHaveLength(1);
  });

  it("detects definition changes and fires onToolDefinitionChanged when hash changes", () => {
    const changes: ToolDefinitionChange[] = [];
    const registry = new ToolRegistry({
      onToolDefinitionChanged: (c) => changes.push(c),
    });

    const v1 = convertMcpToolToDefinition("srv1", {
      name: "search",
      description: "Searches documents",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    });

    // Register v1
    registry.registerTool(v1);
    expect(changes).toHaveLength(0);

    // Register v2 with updated description and parameter schema
    const v2 = convertMcpToolToDefinition("srv1", {
      name: "search",
      description: "Searches documents with advanced filters",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          filter: { type: "string" },
        },
      },
    });

    registry.registerTool(v2);

    // Detected definition change!
    expect(changes).toHaveLength(1);
    expect(changes[0].toolName).toBe("mcp:srv1/search");
    expect(changes[0].oldHash).not.toBe(changes[0].newHash);
    expect(changes[0].newDefinition.description).toContain("advanced filters");
  });

  it("synchronizes tools on tools/list_changed: adds new, updates changed, and removes missing", () => {
    const removed: string[] = [];
    const registry = new ToolRegistry({
      onToolRemoved: (t) => removed.push(t),
    });

    const tool1 = convertMcpToolToDefinition("srv-sync", { name: "tool1", description: "T1" });
    const tool2 = convertMcpToolToDefinition("srv-sync", { name: "tool2", description: "T2" });

    // Initial sync with tool1 and tool2
    registry.syncServerTools("srv-sync", [tool1, tool2]);
    expect(registry.listTools()).toHaveLength(2);

    // Second sync with tool1 updated and tool3 added (tool2 was removed by the server!)
    const tool1Updated = convertMcpToolToDefinition("srv-sync", {
      name: "tool1",
      description: "T1 updated",
    });
    const tool3 = convertMcpToolToDefinition("srv-sync", { name: "tool3", description: "T3" });

    registry.syncServerTools("srv-sync", [tool1Updated, tool3]);

    expect(registry.hasTool("mcp:srv-sync/tool1")).toBe(true);
    expect(registry.hasTool("mcp:srv-sync/tool2")).toBe(false);
    expect(registry.hasTool("mcp:srv-sync/tool3")).toBe(true);
    expect(removed).toContain("mcp:srv-sync/tool2");
  });

  it("unregisters all tools belonging to a specific server on disconnect", () => {
    const registry = new ToolRegistry();
    const toolA1 = convertMcpToolToDefinition("server-A", { name: "tool1" });
    const toolA2 = convertMcpToolToDefinition("server-A", { name: "tool2" });
    const toolB1 = convertMcpToolToDefinition("server-B", { name: "tool1" });

    registry.registerTool(toolA1);
    registry.registerTool(toolA2);
    registry.registerTool(toolB1);

    expect(registry.listTools()).toHaveLength(3);

    // Disconnect server-A
    const removedCount = registry.unregisterServerTools("server-A");
    expect(removedCount).toBe(2);

    // Server B's tools remain completely unaffected
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.hasTool("mcp:server-B/tool1")).toBe(true);
  });
});
