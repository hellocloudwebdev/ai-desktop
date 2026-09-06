import { describe, expect, it } from "vitest";
import {
  ToolCallSchema,
  ToolDefinitionSchema,
  ToolResultSchema,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "./tools.js";
import { createToolCallId, now } from "@ai-desktop/shared";

describe("ai-core tools: Tool Definition and Execution Separation", () => {
  it("enforces independence between ToolSource and ToolRuntime", () => {
    // source=skill, runtime=execution
    const skillTool: ToolDefinition = {
      name: "run_script",
      description: "Runs a custom script in a sandbox",
      source: "skill",
      runtime: "execution",
      parameters: { type: "object", properties: { script: { type: "string" } } },
      requiredPermissions: ["execution:run"],
    };
    expect(ToolDefinitionSchema.safeParse(skillTool).success).toBe(true);

    // source=mcp, runtime=mcp_protocol
    const mcpTool: ToolDefinition = {
      name: "fetch_repo",
      description: "Fetches github repo details via MCP",
      source: "mcp",
      runtime: "mcp_protocol",
      parameters: { type: "object", properties: { repo: { type: "string" } } },
    };
    expect(ToolDefinitionSchema.safeParse(mcpTool).success).toBe(true);
  });

  it("rejects invalid ToolSource or ToolRuntime", () => {
    const badSource = {
      name: "tool",
      description: "desc",
      source: "docker", // Execution is not a tool source!
      runtime: "execution",
      parameters: {},
    };
    expect(ToolDefinitionSchema.safeParse(badSource).success).toBe(false);

    const badRuntime = {
      name: "tool",
      description: "desc",
      source: "builtin",
      runtime: "cloud_server",
      parameters: {},
    };
    expect(ToolDefinitionSchema.safeParse(badRuntime).success).toBe(false);
  });

  it("validates a complete ToolCall lifecycle instance", () => {
    const call: ToolCall = {
      id: createToolCallId(),
      toolName: "read_file",
      toolSource: "builtin",
      toolRuntime: "in_process",
      input: { path: "tsconfig.json" },
      status: "completed",
      createdAt: now(),
      startedAt: now(),
      completedAt: now(),
      metadata: { cacheHit: false },
    };

    expect(ToolCallSchema.safeParse(call).success).toBe(true);
  });

  it("validates a ToolResult instance", () => {
    const result: ToolResult = {
      toolCallId: createToolCallId(),
      toolName: "read_file",
      result: { content: "{}" },
      isError: false,
      durationMs: 42,
      timestamp: now(),
    };

    expect(ToolResultSchema.safeParse(result).success).toBe(true);
  });
});
