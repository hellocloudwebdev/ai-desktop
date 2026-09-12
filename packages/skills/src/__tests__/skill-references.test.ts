import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { asSkillId } from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import { SkillInstaller } from "../core/skill-installer.js";
import { SkillManager, MAX_REFERENCE_BYTES } from "../core/skill-manager.js";
import { SkillToolRegistry } from "../core/tool-registry.js";
import type { CreateSkillData, SkillRepository, StoredSkill } from "@ai-desktop/storage";

class InMemorySkillRepository implements SkillRepository {
  private readonly _skills = new Map<string, StoredSkill>();

  async saveSkill(data: CreateSkillData): Promise<StoredSkill> {
    const s: StoredSkill = {
      id: data.id,
      name: data.name,
      version: data.version,
      description: data.description,
      source: data.source,
      installPath: data.installPath,
      checksum: data.checksum,
      installedAt: data.installedAt,
      updatedAt: data.updatedAt,
      enabled: data.enabled ?? false,
      projectId: data.projectId ?? null,
    };
    this._skills.set(data.id, s);
    return s;
  }

  async getSkillById(id: string): Promise<StoredSkill | null> {
    return this._skills.get(id) ?? null;
  }

  async listSkills(projectId?: string): Promise<StoredSkill[]> {
    return [...this._skills.values()].filter(
      (s) => !projectId || s.projectId === projectId || s.projectId === null,
    );
  }

  async setSkillEnabled(id: string, enabled: boolean, projectId?: string): Promise<StoredSkill> {
    const s = this._skills.get(id);
    if (!s) throw new Error("Not found");
    const updated: StoredSkill = {
      ...s,
      enabled,
      ...(projectId !== undefined && { projectId }),
      updatedAt: Date.now(),
    };
    this._skills.set(id, updated);
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    this._skills.delete(id);
  }
}

function createSkillWithReferences(dir: string, skillId: string) {
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });

  fs.writeFileSync(path.join(dir, "SKILL.md"), "# Main Instruction\n");
  fs.writeFileSync(
    path.join(dir, "references", "guide.md"),
    "# On-Demand Guide\nDetailed reference content.",
  );

  // Large reference file (>512 KB)
  const bigContent = "B".repeat(MAX_REFERENCE_BYTES + 1024);
  fs.writeFileSync(path.join(dir, "references", "oversized.txt"), bigContent);

  const manifest = {
    id: skillId,
    name: "Reference Skill",
    version: "1.0.0",
    description: "Tests on-demand reference loading",
    entry: "SKILL.md",
    references: ["references/guide.md", "references/oversized.txt"],
    scripts: [],
  };

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

describe("packages/skills: Reference Content & Project Isolation (PR26.14, PR26.15)", () => {
  it("loads reference content on demand without dumping into prompt wholesale", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-refs-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSkillWithReferences(sourceDir, "ref-test");

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });

    try {
      await installer.install(sourceDir);
      const skillId = asSkillId("ref-test");

      const content = await manager.loadReference(skillId, "references/guide.md");
      expect(content).toContain("On-Demand Guide");
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("SECURITY: rejects path traversal attempts when loading references", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ref-sec-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSkillWithReferences(sourceDir, "ref-test");

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });

    try {
      await installer.install(sourceDir);
      const skillId = asSkillId("ref-test");

      await expect(manager.loadReference(skillId, "../../etc/passwd")).rejects.toThrow(
        ValidationError,
      );

      await expect(manager.loadReference(skillId, "references/../../../secret")).rejects.toThrow(
        ValidationError,
      );
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("SECURITY: rejects oversized reference files exceeding the 512 KB ceiling", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ref-size-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSkillWithReferences(sourceDir, "ref-test");

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });

    try {
      await installer.install(sourceDir);
      const skillId = asSkillId("ref-test");

      await expect(manager.loadReference(skillId, "references/oversized.txt")).rejects.toThrow(
        /exceeds the 524288 byte limit/,
      );
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("enforces project isolation: Skill enabled for Project A cannot be activated in Project B", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-proj-iso-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSkillWithReferences(sourceDir, "scoped-skill");

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });

    try {
      // Install scoped strictly to project-A
      await installer.install(sourceDir, { projectId: "project-A" });
      const skillId = asSkillId("scoped-skill");

      await manager.enable(skillId, "project-A");

      // Activation in Project A succeeds
      await expect(manager.activate(skillId, "project-A")).resolves.toBeDefined();

      // Activation in Project B is BLOCKED by project isolation (§PR26.15)
      await expect(manager.activate(skillId, "project-B")).rejects.toThrow(ValidationError);
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
