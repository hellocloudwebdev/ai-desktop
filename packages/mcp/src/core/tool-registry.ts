// PR25.8: packages/mcp — Tool Registry & Definition Change Tracking
//
// Invariants:
//   1. Registers tools by stable canonical ID (mcp:<serverId>/<toolName>).
//   2. Calculates SHA-256 definition hash for every tool.
//   3. When a definition hash changes, invalidates affected trust grants.
//   4. Supports dynamic synchronization from MCPHost on tools/list_changed.

import type { ToolDefinition } from "@ai-desktop/ai-core";
import { computeToolDefinitionHash, parseCanonicalToolId } from "./tool-converter.js";

export interface ToolDefinitionChange {
  readonly toolName: string;
  readonly oldHash: string;
  readonly newHash: string;
  readonly oldDefinition: ToolDefinition;
  readonly newDefinition: ToolDefinition;
}

export interface ToolRegistryEvents {
  onToolDefinitionChanged?: (change: ToolDefinitionChange) => void;
  onToolRemoved?: (toolName: string) => void;
}

export class ToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();
  private readonly _hashes = new Map<string, string>();
  private readonly _events?: ToolRegistryEvents;

  constructor(events?: ToolRegistryEvents) {
    this._events = events;
  }

  /**
   * Registers a canonical ToolDefinition.
   * Detects definition changes and notifies if hash changed.
   */
  registerTool(def: ToolDefinition): void {
    const existing = this._tools.get(def.name);
    const existingHash = this._hashes.get(def.name);

    const newHash =
      (def.metadata?.definitionHash as string | undefined) ??
      computeToolDefinitionHash({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        runtime: def.runtime,
      });

    if (existing && existingHash && existingHash !== newHash) {
      // Definition has changed! Invalidate trust
      this._events?.onToolDefinitionChanged?.({
        toolName: def.name,
        oldHash: existingHash,
        newHash,
        oldDefinition: existing,
        newDefinition: def,
      });
    }

    this._tools.set(def.name, def);
    this._hashes.set(def.name, newHash);
  }

  /**
   * Unregisters a tool by canonical ID.
   */
  unregisterTool(name: string): boolean {
    const existed = this._tools.delete(name);
    this._hashes.delete(name);
    if (existed) {
      this._events?.onToolRemoved?.(name);
    }
    return existed;
  }

  /**
   * Unregisters all tools belonging to a specific server.
   */
  unregisterServerTools(serverId: string): number {
    let count = 0;
    for (const name of [...this._tools.keys()]) {
      const parsed = parseCanonicalToolId(name);
      if (parsed && parsed.serverId === serverId) {
        this.unregisterTool(name);
        count++;
      }
    }
    return count;
  }

  /**
   * Synchronizes tools from a server list.
   * Handles additions, updates (with definition hash changes), and removals.
   */
  syncServerTools(serverId: string, newTools: readonly ToolDefinition[]): void {
    const currentServerToolNames = new Set<string>();
    for (const name of this._tools.keys()) {
      const parsed = parseCanonicalToolId(name);
      if (parsed && parsed.serverId === serverId) {
        currentServerToolNames.add(name);
      }
    }

    const incomingNames = new Set<string>();
    for (const tool of newTools) {
      incomingNames.add(tool.name);
      this.registerTool(tool);
    }

    // Tools that existed previously but are not in the new list are removed
    for (const oldName of currentServerToolNames) {
      if (!incomingNames.has(oldName)) {
        this.unregisterTool(oldName);
      }
    }
  }

  resolve(name: string): ToolDefinition | undefined {
    return this._tools.get(name);
  }

  hasTool(name: string): boolean {
    return this._tools.has(name);
  }

  listTools(): readonly ToolDefinition[] {
    return [...this._tools.values()];
  }

  getToolHash(name: string): string | undefined {
    return this._hashes.get(name);
  }

  clear(): void {
    this._tools.clear();
    this._hashes.clear();
  }
}
