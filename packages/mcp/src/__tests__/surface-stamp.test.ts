// PR33.12: mcp — Surface Stamp Tests
//
// The executor stamps provider descriptors additively; unconfigured tools
// produce no stamp. Binding enforcement lives in SurfaceService.

import { describe, expect, it } from "vitest";
import { extractSurfaceDescriptor } from "@ai-desktop/ai-core";
import { McpToolExecutor } from "../core/mcp-tool-executor.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { PermissionManager } from "@ai-desktop/permissions";

const DESCRIPTOR = { id: "mcp-table", version: "1.0.0", kind: "table", title: "MCP" } as const;

function createExecutor(surfaceFor?: string) {
  const registry = {
    resolve: (name: string) =>
      name === "mcp:server/tool"
        ? {
            name,
            description: "Tool",
            source: "mcp",
            runtime: "mcp_protocol",
            parameters: { type: "object", properties: {}, required: [] },
          }
        : undefined,
  } as unknown as ToolRegistry;
  const permissions = {
    check: async () => ({ kind: "allow" }),
  } as unknown as PermissionManager;
  const host = {
    callTool: async () => ({
      toolCallId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA",
      toolName: "mcp:server/tool",
      result: "ok",
      isError: false,
      durationMs: 1,
      timestamp: new Date().toISOString(),
    }),
  } as never;
  return new McpToolExecutor(
    registry,
    permissions,
    host,
    undefined,
    surfaceFor ? () => DESCRIPTOR as never : undefined,
  );
}

describe("mcp: surface stamp (PR33.12)", () => {
  it("stamps metadata.surface when a provider is configured", async () => {
    const executor = createExecutor("mcp:server/tool");
    const result = await executor.execute("mcp:server/tool", {});
    expect(result.isError).toBe(false);
    expect(extractSurfaceDescriptor(result.metadata)).toMatchObject({ id: "mcp-table" });
  });

  it("produces no stamp without a provider", async () => {
    const executor = createExecutor();
    const result = await executor.execute("mcp:server/tool", {});
    expect(result.isError).toBe(false);
    expect(extractSurfaceDescriptor(result.metadata)).toBeNull();
  });
});
