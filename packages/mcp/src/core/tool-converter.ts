// PR25.7 & PR25.8 + PR38: packages/mcp — Tool Discovery and Conversion
//
// Invariants:
//   1. ToolSource must be "mcp", ToolRuntime must be "mcp_protocol".
//   2. Stable tool ID: mcp:<serverId>/<toolName>.
//   3. Deterministic SHA-256 definition hash for detecting changes.
//   4. MCP SDK types are encapsulated; consumers only receive canonical ToolDefinition/ToolResult.
//   5. PR38: call-result conversion preserves normalized structured contents
//      (text/image/audio/resource/structured per the ai-core
//      MCPToolResultContent shapes) in metadata.structuredContents while the
//      legacy `result` string behavior is unchanged (no breaking change).
//      Normalization is best-effort and never throws.

import { createHash } from "node:crypto";
import { createToolCallId, now, type ToolCallId } from "@ai-desktop/shared";
import type { MCPToolResultContent, ToolDefinition, ToolResult } from "@ai-desktop/ai-core";

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
    structuredContent?: unknown;
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

  const metadata: Record<string, unknown> = {
    rawMcpResult: anyResult,
  };
  const structuredContents = normalizeMcpResultContents(anyResult);
  if (structuredContents) {
    metadata.structuredContents = structuredContents;
  }

  return {
    toolCallId: toolCallId ?? createToolCallId(),
    toolName: canonicalToolName,
    result: extractedContent,
    isError,
    durationMs,
    timestamp: now(),
    metadata,
  };
}

/**
 * Normalizes raw MCP call-result content blocks to the ai-core
 * MCPToolResultContent shapes. Best-effort: unknown blocks are carried as
 * structured JSON, unparseable payloads yield undefined (never throws).
 * Capped at 32 entries to match the ai-core bound.
 */
function normalizeMcpResultContents(raw: {
  content?: unknown;
  structuredContent?: unknown;
}): MCPToolResultContent[] | undefined {
  try {
    const out: MCPToolResultContent[] = [];
    const blocks = Array.isArray(raw?.content) ? raw.content : [];
    for (const block of blocks.slice(0, 32)) {
      const normalized = normalizeMcpContentBlock(block);
      if (normalized) {
        out.push(normalized);
      }
    }
    if (raw?.structuredContent !== undefined && out.length < 32) {
      const structured = raw.structuredContent;
      if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
        out.push({ kind: "structured", structured: structured as Record<string, unknown> });
      } else {
        out.push({ kind: "structured", structured: { value: structured } });
      }
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMcpContentBlock(block: unknown): MCPToolResultContent | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const b = block as {
    type?: unknown;
    text?: unknown;
    data?: unknown;
    mimeType?: unknown;
    resource?: unknown;
  };
  const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;

  switch (b.type) {
    case "text":
      return typeof b.text === "string" ? { kind: "text", text: b.text, mimeType } : undefined;
    case "image":
      return typeof b.data === "string" ? { kind: "image", base64: b.data, mimeType } : undefined;
    case "audio":
      return typeof b.data === "string" ? { kind: "audio", base64: b.data, mimeType } : undefined;
    case "resource": {
      const resource = b.resource as
        { uri?: unknown; text?: unknown; blob?: unknown; mimeType?: unknown } | undefined;
      const resourceUri = resource && typeof resource.uri === "string" ? resource.uri : undefined;
      if (!resourceUri) {
        return { kind: "resource", structured: { value: b.resource ?? null } };
      }
      const entry: MCPToolResultContent = { kind: "resource", resourceUri };
      if (typeof resource?.text === "string") {
        entry.text = resource.text;
      }
      if (typeof resource?.blob === "string") {
        entry.base64 = resource.blob;
      }
      const resourceMime = resource?.mimeType;
      if (typeof resourceMime === "string") {
        entry.mimeType = resourceMime;
      } else if (mimeType) {
        entry.mimeType = mimeType;
      }
      return entry;
    }
    default:
      // Unknown block type: carry the raw block as structured data, or as
      // text when it has a text field.
      if (typeof b.text === "string") {
        return { kind: "text", text: b.text, mimeType };
      }
      return { kind: "structured", structured: { value: b } };
  }
}
