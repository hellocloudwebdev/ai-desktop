// PR38: apps/desktop — MCP Host Singleton + Surface Descriptor Bridge
//
// Owns the desktop InProcessMCPHost and bridges MCP structured results into
// the PR33 RichSurface system. The host stays the only MCP SDK touchpoint;
// surfaces are created through SurfaceService permission gates, never
// directly from tool metadata.

import { InProcessMCPHost, buildMcpAppDescriptor, type MCPHost } from "@ai-desktop/mcp";
import type { RichSurfaceDescriptor } from "@ai-desktop/ai-core";

let mcpHost: MCPHost | null = null;

export function getMcpHost(): MCPHost {
  if (!mcpHost) {
    mcpHost = new InProcessMCPHost();
  }
  return mcpHost;
}

/** Test seam: replace the desktop MCP host instance. */
export function setMcpHostForTesting(host: MCPHost | null): void {
  mcpHost = host;
}

/**
 * McpSurfaceProvider implementation: converts a tool result's structured
 * contents into a renderable descriptor (document/table/form only).
 * Returns undefined when nothing renderable is present.
 */
export function mcpSurfaceDescriptorFor(toolResult: {
  toolName: string;
  metadata?: Record<string, unknown>;
}): RichSurfaceDescriptor | undefined {
  return buildMcpAppDescriptor({
    toolName: toolResult.toolName,
    ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
  });
}
