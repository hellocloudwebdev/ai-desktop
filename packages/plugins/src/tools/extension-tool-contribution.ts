// PR32: packages/plugins — Plugin Tool Contribution Registry
//
// Invariants:
//   1. Tool ID format: plugin:<extensionId>/<toolName>.
//   2. ToolDefinition uses source "plugin" (reuses ai-core ToolSource) and
//      runtime "in_process" with requiredPermissions ["plugin"].
//   3. Definition hash mirrors the MCP-style hash (name/description/parameters JSON sha256).
//   4. Project scoping: resolveForProject enforces per-project enablement.

import { createHash } from "node:crypto";
import type { ToolDefinition } from "@ai-desktop/ai-core";

export function toCanonicalPluginToolId(extensionId: string, toolName: string): string {
  return `plugin:${extensionId}/${toolName}`;
}

export function parseCanonicalPluginToolId(
  canonicalId: string,
): { extensionId: string; toolName: string } | null {
  if (!canonicalId.startsWith("plugin:")) {
    return null;
  }
  const rest = canonicalId.slice(7);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) {
    return null;
  }
  return {
    extensionId: rest.slice(0, slashIdx),
    toolName: rest.slice(slashIdx + 1),
  };
}

export function computePluginToolDefinitionHash(params: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}): string {
  const content = JSON.stringify({
    name: params.name,
    description: params.description,
    parameters: params.parameters,
  });
  return createHash("sha256").update(content).digest("hex");
}

export interface PluginToolContributionInput {
  readonly extensionId: string;
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly parameters?: Record<string, unknown>;
    readonly timeoutMs?: number;
  };
}

export function buildPluginToolDefinition(
  input: PluginToolContributionInput,
  manifestHash: string,
): ToolDefinition {
  const canonicalName = toCanonicalPluginToolId(input.extensionId, input.tool.name);
  const parameters = input.tool.parameters ?? { type: "object", properties: {} };
  const definitionHash = computePluginToolDefinitionHash({
    name: canonicalName,
    description: input.tool.description,
    parameters,
  });
  return {
    name: canonicalName,
    description: input.tool.description,
    source: "plugin",
    runtime: "in_process",
    parameters,
    requiredPermissions: ["plugin"],
    metadata: {
      extensionId: input.extensionId,
      toolName: input.tool.name,
      definitionHash,
      manifestHash,
      timeoutMs: input.tool.timeoutMs,
    },
  };
}

export class PluginToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();

  registerTool(def: ToolDefinition): void {
    this._tools.set(def.name, def);
  }

  unregisterTool(name: string): boolean {
    return this._tools.delete(name);
  }

  unregisterExtensionTools(extensionId: string): number {
    let count = 0;
    for (const name of [...this._tools.keys()]) {
      const parsed = parseCanonicalPluginToolId(name);
      if (parsed && parsed.extensionId === extensionId) {
        this._tools.delete(name);
        count++;
      }
    }
    return count;
  }

  resolve(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  /**
   * Resolves a tool for a project: returns undefined unless the extension is
   * enabled for that project per isEnabledForProject.
   */
  resolveForProject(
    name: string,
    projectId: string,
    isEnabledForProject: (extensionId: string, projectId: string) => boolean,
  ): ToolDefinition | undefined {
    const def = this._tools.get(name);
    if (!def) {
      return undefined;
    }
    const parsed = parseCanonicalPluginToolId(name);
    if (!parsed) {
      return undefined;
    }
    if (!isEnabledForProject(parsed.extensionId, projectId)) {
      return undefined;
    }
    return def;
  }

  hasTool(name: string): boolean {
    return this._tools.has(name);
  }

  listTools(): readonly ToolDefinition[] {
    return [...this._tools.values()];
  }

  clear(): void {
    this._tools.clear();
  }
}
