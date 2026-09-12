import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import {
  computeToolDefinitionHash,
  convertMcpCallResultToToolResult,
  convertMcpToolToDefinition,
  parseCanonicalToolId,
  toCanonicalToolId,
  type McpRawTool,
} from "../core/tool-converter.js";

describe("packages/mcp: Tool Converter & ID Invariants (PR25.7, PR25.8)", () => {
  it("formats canonical tool IDs in the locked format: mcp:<serverId>/<toolName>", () => {
    expect(toCanonicalToolId("github", "get_issue")).toBe("mcp:github/get_issue");
    expect(toCanonicalToolId("fs-server", "read_file")).toBe("mcp:fs-server/read_file");

    const parsed = parseCanonicalToolId("mcp:github/get_issue");
    expect(parsed).toEqual({ serverId: "github", toolName: "get_issue" });

    expect(parseCanonicalToolId("non-mcp-tool")).toBeNull();
  });

  it("converts raw MCP tool into canonical ToolDefinition with source=mcp and runtime=mcp_protocol", () => {
    const rawTool: McpRawTool = {
      name: "fetch_weather",
      description: "Fetches current weather for a city",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
    };

    const canonical = convertMcpToolToDefinition("weather-srv", rawTool);

    expect(canonical.name).toBe("mcp:weather-srv/fetch_weather");
    expect(canonical.description).toBe("Fetches current weather for a city");
    expect(canonical.source).toBe("mcp");
    expect(canonical.runtime).toBe("mcp_protocol");
    expect(canonical.parameters).toEqual(rawTool.inputSchema);
    expect(canonical.metadata?.serverId).toBe("weather-srv");
    expect(canonical.metadata?.rawName).toBe("fetch_weather");
    expect(canonical.metadata?.definitionHash).toBeDefined();
  });

  it("calculates deterministic SHA-256 definition hash", () => {
    const hash1 = computeToolDefinitionHash({
      name: "mcp:s1/tool1",
      description: "A tool",
      parameters: { type: "object", properties: { x: { type: "number" } } },
      runtime: "mcp_protocol",
    });

    const hash2 = computeToolDefinitionHash({
      name: "mcp:s1/tool1",
      description: "A tool",
      parameters: { type: "object", properties: { x: { type: "number" } } },
      runtime: "mcp_protocol",
    });

    // Same input produces identical hash
    expect(hash1).toBe(hash2);

    // Changed description produces different hash
    const hash3 = computeToolDefinitionHash({
      name: "mcp:s1/tool1",
      description: "Changed description",
      parameters: { type: "object", properties: { x: { type: "number" } } },
      runtime: "mcp_protocol",
    });

    expect(hash3).not.toBe(hash1);
  });

  it("converts MCP call result into canonical ToolResult without leaking SDK structures", () => {
    const toolCallId = createToolCallId();
    const mcpResult = {
      content: [
        {
          type: "text",
          text: '{"temperature": 22, "condition": "sunny"}',
        },
      ],
      isError: false,
    };

    const toolResult = convertMcpCallResultToToolResult({
      toolCallId,
      canonicalToolName: "mcp:weather/get_temp",
      mcpResult,
      durationMs: 42,
    });

    expect(toolResult.toolCallId).toBe(toolCallId);
    expect(toolResult.toolName).toBe("mcp:weather/get_temp");
    expect(toolResult.result).toBe('{"temperature": 22, "condition": "sunny"}');
    expect(toolResult.isError).toBe(false);
    expect(toolResult.durationMs).toBe(42);
    expect(toolResult.timestamp).toBeDefined();
  });
});
