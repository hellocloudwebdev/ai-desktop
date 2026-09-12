// PR26.7, PR26.8, PR26.9, PR26.14, PR26.15: packages/skills — Skill Lifecycle & Reference Loader
//
// Invariants:
//   1. Lifecycle states: Installed -> Enabled -> Active.
//   2. Tools are registered in ToolRegistry ONLY when Skill is Active.
//   3. Project isolation: skills can be enabled per project; inactive in other projects.
//   4. Reference content is loaded on demand with strict path safety (never wholesale in prompt).
//   5. Deactivating or disabling unregisters tools immediately.

import fs from "node:fs";
import path from "node:path";
import { type SkillId, asSkillId, type ToolDefinition } from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import type { SkillRepository, StoredSkill } from "@ai-desktop/storage";
import {
  isSafeRelativePath,
  type SkillManifest,
  type SkillPackageInfo,
  type SkillState,
} from "./skill-manifest.js";
import { toCanonicalSkillToolId, type SkillToolRegistry } from "./tool-registry.js";
import { validateSkillPackage } from "./skill-validator.js";

export const MAX_REFERENCE_BYTES = 512 * 1024; // 512 KB maximum per reference file

export interface SkillManagerOptions {
  readonly repository: SkillRepository;
  readonly toolRegistry: SkillToolRegistry;
}

export class SkillManager {
  private readonly _repository: SkillRepository;
  private readonly _toolRegistry: SkillToolRegistry;
  private readonly _activeSkills = new Set<string>(); // active skillIds
  private readonly _skillErrors = new Map<string, string>(); // skillId -> error

  constructor(options: SkillManagerOptions) {
    this._repository = options.repository;
    this._toolRegistry = options.toolRegistry;
  }

  get toolRegistry(): SkillToolRegistry {
    return this._toolRegistry;
  }

  /**
   * Enables an installed skill (for a project or globally).
   */
  async enable(skillId: SkillId, projectId?: string): Promise<void> {
    const skill = await this._repository.getSkillById(skillId);
    if (!skill) {
      throw new ValidationError(`Cannot enable skill "${skillId}": not installed`);
    }

    await this._repository.setSkillEnabled(skillId, true, projectId);
  }

  /**
   * Disables a skill. Immediately deactivates and unregisters its tools.
   */
  async disable(skillId: SkillId, projectId?: string): Promise<void> {
    const skill = await this._repository.getSkillById(skillId);
    if (!skill) {
      return;
    }

    this.deactivate(skillId);
    await this._repository.setSkillEnabled(skillId, false, projectId);
  }

  /**
   * Activates an installed and enabled skill:
   *   1. Checks installed and enabled.
   *   2. Validates package files on disk.
   *   3. Registers declared tools in ToolRegistry.
   *   4. Marks as Active.
   */
  async activate(skillId: SkillId, projectId?: string): Promise<readonly ToolDefinition[]> {
    const stored = await this._repository.getSkillById(skillId);
    if (!stored) {
      throw new ValidationError(`Cannot activate skill "${skillId}": not installed`);
    }

    // Check project scoping
    if (stored.projectId && projectId && stored.projectId !== projectId) {
      throw new ValidationError(
        `Skill "${skillId}" belongs to project "${stored.projectId}" and cannot be activated in "${projectId}"`,
      );
    }

    if (!stored.enabled) {
      throw new ValidationError(`Cannot activate skill "${skillId}": skill is disabled`);
    }

    // Re-validate package on disk before activation (§PR26.8)
    const validationRes = validateSkillPackage(stored.installPath);
    if (!validationRes.ok) {
      this._activeSkills.delete(skillId);
      this._skillErrors.set(skillId, validationRes.error.message);
      throw new ValidationError(
        `Failed to activate skill "${skillId}": package validation failed: ${validationRes.error.message}`,
      );
    }

    const { manifest } = validationRes.value;
    const registeredTools: ToolDefinition[] = [];

    // Register each declared script as a canonical ToolDefinition
    for (const script of manifest.scripts) {
      const canonicalName = toCanonicalSkillToolId(skillId, script.name);
      const fullScriptPath = path.join(stored.installPath, script.path);

      const toolDef: ToolDefinition = {
        name: canonicalName,
        description: script.description,
        source: "skill",
        runtime: "execution",
        parameters: script.parameters,
        requiredPermissions: script.requiredPermissions,
        metadata: {
          skillId,
          scriptName: script.name,
          scriptPath: fullScriptPath,
          command: script.command,
          approvedChecksum: script.checksum,
          timeoutMs: script.timeoutMs,
          installPath: stored.installPath,
        },
      };

      this._toolRegistry.registerTool(toolDef);
      registeredTools.push(toolDef);
    }

    this._activeSkills.add(skillId);
    this._skillErrors.delete(skillId);

    return registeredTools;
  }

  /**
   * Deactivates a skill and removes its tools from ToolRegistry.
   */
  deactivate(skillId: SkillId): void {
    this._activeSkills.delete(skillId);
    this._toolRegistry.unregisterSkillTools(skillId);
  }

  /**
   * Checks whether a skill is currently active.
   */
  isActive(skillId: SkillId): boolean {
    return this._activeSkills.has(skillId);
  }

  /**
   * Loads reference content on demand with strict relative path safety (§PR26.14).
   * Never injects references wholesale into prompts.
   */
  async loadReference(skillId: SkillId, relativePath: string): Promise<string> {
    const stored = await this._repository.getSkillById(skillId);
    if (!stored) {
      throw new ValidationError(`Skill "${skillId}" is not installed`);
    }

    if (!isSafeRelativePath(relativePath)) {
      throw new ValidationError(`Path traversal or unsafe path rejected: "${relativePath}"`);
    }

    const fullPath = path.join(stored.installPath, relativePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new ValidationError(`Reference file "${relativePath}" not found in skill "${skillId}"`);
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_REFERENCE_BYTES) {
      throw new ValidationError(
        `Reference file "${relativePath}" (${stats.size} bytes) exceeds the ${MAX_REFERENCE_BYTES} byte limit`,
      );
    }

    return fs.readFileSync(fullPath, "utf8");
  }

  /**
   * Retrieves info for a specific skill.
   */
  async getSkillInfo(skillId: SkillId): Promise<SkillPackageInfo | undefined> {
    const stored = await this._repository.getSkillById(skillId);
    if (!stored) return undefined;
    return this._toSkillPackageInfo(stored);
  }

  /**
   * Lists all installed skills with their current state (Installed/Enabled/Active).
   */
  async listSkills(projectId?: string): Promise<readonly SkillPackageInfo[]> {
    const list = await this._repository.listSkills(projectId);
    const infos: SkillPackageInfo[] = [];
    for (const s of list) {
      infos.push(this._toSkillPackageInfo(s));
    }
    return infos;
  }

  private _toSkillPackageInfo(stored: StoredSkill): SkillPackageInfo {
    const active = this._activeSkills.has(stored.id);
    let state: SkillState = "installed";
    if (active) {
      state = "active";
    } else if (stored.enabled) {
      state = "enabled";
    }

    const error = this._skillErrors.get(stored.id);

    // Read manifest to get declared capabilities and scripts count
    let capabilities: readonly string[] = [];
    let scriptCount = 0;
    try {
      const manifestPath = path.join(stored.installPath, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SkillManifest;
        capabilities = manifest.capabilities ?? [];
        scriptCount = manifest.scripts?.length ?? 0;
      }
    } catch {
      // ignore
    }

    return {
      id: asSkillId(stored.id),
      name: stored.name,
      version: stored.version,
      description: stored.description,
      capabilities,
      state,
      installPath: stored.installPath,
      installedAt: stored.installedAt,
      updatedAt: stored.updatedAt,
      enabled: stored.enabled,
      active,
      error,
      scriptCount,
    };
  }
}
