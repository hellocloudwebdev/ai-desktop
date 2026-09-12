// PR26.8 & PR26.9: packages/skills — Skill Tool Registry
//
// Invariants:
//   1. Registers tools from active skills: source = "skill", runtime = "execution".
//   2. Tool ID format: skill:<skillId>/<toolName>.
//   3. Only active skills may have tools registered in the registry.
//   4. On disable or uninstall, tools are cleanly unregistered.

import type { ToolDefinition } from "@ai-desktop/ai-core";

export function toCanonicalSkillToolId(skillId: string, toolName: string): string {
  return `skill:${skillId}/${toolName}`;
}

export function parseCanonicalSkillToolId(
  canonicalId: string,
): { skillId: string; toolName: string } | null {
  if (!canonicalId.startsWith("skill:")) {
    return null;
  }
  const rest = canonicalId.slice(6);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) {
    return null;
  }
  return {
    skillId: rest.slice(0, slashIdx),
    toolName: rest.slice(slashIdx + 1),
  };
}

export class SkillToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>();

  registerTool(def: ToolDefinition): void {
    this._tools.set(def.name, def);
  }

  unregisterTool(name: string): boolean {
    return this._tools.delete(name);
  }

  unregisterSkillTools(skillId: string): number {
    let count = 0;
    for (const name of [...this._tools.keys()]) {
      const parsed = parseCanonicalSkillToolId(name);
      if (parsed && parsed.skillId === skillId) {
        this._tools.delete(name);
        count++;
      }
    }
    return count;
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

  clear(): void {
    this._tools.clear();
  }
}
