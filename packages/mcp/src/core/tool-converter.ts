// PR25.7 & PR25.8: packages/mcp — Tool Discovery and Conversion
//
// Invariants:
//   1. ToolSource must be "mcp", ToolRuntime must be "mcp_protocol".
//   2. Stable tool ID: mcp:<serverId>/<toolName>.
//   3. Deterministic SHA-256 definition hash for detecting changes.
//   4. MCP SDK types are encapsulated; consumers only receive canonical ToolDefinition/ToolResult.

import { createHash } from "node:crypto";
import { createToolCallId, now, type ToolCallId } from "@ai-desktop/shared";
import type { ToolDefinition, ToolResult } from "@ai-desktop/ai-core";

export interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function computeToolDefinitionHash(params: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  runtime: string;
}): string {
  const content = JSON.stringify({
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    runtime: params.runtime,
  });
  return createHash("sha256").update(content).digest("hex");
}

export function toCanonicalToolId(serverId: string, toolName: string): string {
  return `mcp:${serverId}/${toolName}`;
}

export function parseCanonicalToolId(
  canonicalId: string,
): { serverId: string; toolName: string } | null {
  if (!canonicalId.startsWith("mcp:")) {
    return null;
  }
  const rest = canonicalId.slice(4);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) {
    return null;
  }
  return {
    serverId: rest.slice(0, slashIdx),
    toolName: rest.slice(slashIdx + 1),
  };
}

export function convertMcpToolToDefinition(serverId: string, rawTool: McpRawTool): ToolDefinition {
  const canonicalName = toCanonicalToolId(serverId, rawTool.name);
  const description = rawTool.description ?? "";
  const parameters = (rawTool.inputSchema as Record<string, unknown>) ?? {
    type: "object",
    properties: {},
  };
  const runtime = "mcp_protocol";

  const definitionHash = computeToolDefinitionHash({
    name: canonicalName,
    description,
    parameters,
    runtime,
  });

  return {
    name: canonicalName,
    description,
    source: "mcp",
    runtime,
    parameters,
    metadata: {
      serverId,
      rawName: rawTool.name,
      definitionHash,
    },
  };
}

export function convertMcpCallResultToToolResult(params: {
  toolCallId?: ToolCallId;
  canonicalToolName: string;
  mcpResult: unknown;
  durationMs?: number;
}): ToolResult {
  const { toolCallId, canonicalToolName, mcpResult, durationMs } = params;
  const anyResult = mcpResult as {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };

  const isError = Boolean(anyResult?.isError);
  let extractedContent: unknown = anyResult?.content;

  if (Array.isArray(anyResult?.content)) {
    if (anyResult.content.length === 1 && anyResult.content[0].type === "text") {
      extractedContent = anyResult.content[0].text;
    } else {
      extractedContent = anyResult.content;
    }
  }

  return {
    toolCallId: toolCallId ?? createToolCallId(),
    toolName: canonicalToolName,
    result: extractedContent,
    isError,
    durationMs,
    timestamp: now(),
    metadata: {
      rawMcpResult: anyResult,
    },
  };
}
