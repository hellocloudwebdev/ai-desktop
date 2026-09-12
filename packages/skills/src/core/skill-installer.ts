// PR26.5 & PR26.16: packages/skills — Skill Package Installer & Uninstaller
//
// Invariants:
//   1. Installation pipeline: validate -> copy -> compute integrity -> persist metadata.
//   2. Never executes code during installation.
//   3. Uninstallation unregisters tools and removes package safely without rewriting historical events.
//   4. Package files reside in install directory; metadata in SkillRepository.

import fs from "node:fs";
import path from "node:path";
import type { SkillId } from "@ai-desktop/ai-core";
import { ValidationError, type Result, ok, err } from "@ai-desktop/shared";
import type { SkillRepository } from "@ai-desktop/storage";
import type { SkillPackageInfo } from "./skill-manifest.js";
import { validateSkillPackage } from "./skill-validator.js";

export interface SkillInstallerOptions {
  readonly installBaseDir: string;
  readonly repository: SkillRepository;
  readonly onUninstall?: (skillId: SkillId) => void;
}

export class SkillInstaller {
  private readonly _installBaseDir: string;
  private readonly _repository: SkillRepository;
  private readonly _onUninstall?: (skillId: SkillId) => void;

  constructor(options: SkillInstallerOptions) {
    this._installBaseDir = options.installBaseDir;
    this._repository = options.repository;
    this._onUninstall = options.onUninstall;

    if (!fs.existsSync(this._installBaseDir)) {
      fs.mkdirSync(this._installBaseDir, { recursive: true });
    }
  }

  /**
   * Installs a Skill package from a local directory.
   * Safety invariant: validates BEFORE copying; runs ZERO code during installation.
   */
  async install(
    sourceDir: string,
    options?: { projectId?: string },
  ): Promise<Result<SkillPackageInfo, ValidationError>> {
    // 1. Validate package structure and manifest
    const validationRes = validateSkillPackage(sourceDir);
    if (!validationRes.ok) {
      return err(validationRes.error);
    }
    const { manifest } = validationRes.value;

    const targetDir = path.join(this._installBaseDir, manifest.id);

    try {
      // 2. Safely copy files into target installation directory
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.cpSync(sourceDir, targetDir, { recursive: true });

      // 3. Compute package manifest checksum
      const manifestPath = path.join(targetDir, "manifest.json");
      const manifestChecksum = (await import("node:crypto"))
        .createHash("sha256")
        .update(fs.readFileSync(manifestPath))
        .digest("hex");

      const ts = Date.now();

      // 4. Persist metadata to storage repository (§PR26.6)
      const stored = await this._repository.saveSkill({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        source: "local",
        installPath: targetDir,
        checksum: manifestChecksum,
        installedAt: ts,
        updatedAt: ts,
        enabled: false,
        projectId: options?.projectId ?? null,
      });

      return ok({
        id: manifest.id,
        name: stored.name,
        version: stored.version,
        description: stored.description,
        capabilities: manifest.capabilities,
        state: "installed",
        installPath: stored.installPath,
        installedAt: stored.installedAt,
        updatedAt: stored.updatedAt,
        enabled: stored.enabled,
        active: false,
        scriptCount: manifest.scripts.length,
      });
    } catch (copyErr: unknown) {
      // Cleanup on failure
      if (fs.existsSync(targetDir)) {
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      return err(
        new ValidationError(
          `Failed to copy skill files to "${targetDir}": ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
        ),
      );
    }
  }

  /**
   * Uninstalls a Skill package, removes its files and deletes metadata.
   */
  async uninstall(skillId: SkillId): Promise<void> {
    const existing = await this._repository.getSkillById(skillId);

    // 1. Notify uninstallation listener to unregister tools
    this._onUninstall?.(skillId);

    // 2. Delete from repository
    await this._repository.deleteSkill(skillId);

    // 3. Remove files from disk safely
    if (existing && fs.existsSync(existing.installPath)) {
      try {
        fs.rmSync(existing.installPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  /**
   * Updates an existing Skill package with a new source version.
   */
  async update(
    skillId: SkillId,
    newSourceDir: string,
  ): Promise<Result<SkillPackageInfo, ValidationError>> {
    const existing = await this._repository.getSkillById(skillId);
    if (!existing) {
      return err(new ValidationError(`Skill "${skillId}" is not installed`));
    }

    const validationRes = validateSkillPackage(newSourceDir);
    if (!validationRes.ok) {
      return err(validationRes.error);
    }

    if (validationRes.value.manifest.id !== skillId) {
      return err(
        new ValidationError(
          `Cannot update skill "${skillId}": new manifest specifies id "${validationRes.value.manifest.id}"`,
        ),
      );
    }

    // Safely re-install over the target directory
    return this.install(newSourceDir, { projectId: existing.projectId ?? undefined });
  }
}
