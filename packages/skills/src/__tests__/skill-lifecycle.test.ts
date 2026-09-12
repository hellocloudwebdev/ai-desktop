import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { asSkillId } from "@ai-desktop/ai-core";
import { SkillInstaller } from "../core/skill-installer.js";
import { SkillManager } from "../core/skill-manager.js";
import { SkillToolRegistry } from "../core/tool-registry.js";
import { computeFileChecksum } from "../core/skill-validator.js";
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

function createSampleSkill(dir: string, skillId: string, toolName: string) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });

  const scriptPath = path.join(dir, "scripts", `${toolName}.js`);
  fs.writeFileSync(scriptPath, `console.log("${toolName} executed");\n`);
  const checksum = computeFileChecksum(scriptPath);

  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skillId}\n`);
  fs.writeFileSync(path.join(dir, "references", "guide.md"), "# Guide\n");

  const manifest = {
    id: skillId,
    name: `Sample ${skillId}`,
    version: "1.0.0",
    description: "Sample description",
    capabilities: ["execution"],
    entry: "SKILL.md",
    references: ["references/guide.md"],
    scripts: [
      {
        name: toolName,
        path: `scripts/${toolName}.js`,
        command: "node",
        description: `Tool ${toolName}`,
        checksum,
      },
    ],
  };

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

describe("packages/skills: Skill Lifecycle (PR26.3, PR26.5, PR26.7, PR26.8, PR26.9)", () => {
  it("enforces Installed -> Enabled -> Active lifecycle states", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-lifecycle-"));
    const sourceDir = path.join(tmpBaseDir, "source-skill");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSampleSkill(sourceDir, "code-audit", "audit");

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });

    try {
      // 1. Install
      const installRes = await installer.install(sourceDir);
      expect(installRes.ok).toBe(true);
      if (!installRes.ok) return;

      const skillId = asSkillId("code-audit");
      const info1 = await manager.getSkillInfo(skillId);
      expect(info1?.state).toBe("installed");
      expect(info1?.enabled).toBe(false);
      expect(info1?.active).toBe(false);

      // Invariant: Installed does NOT mean tools are in ToolRegistry (§PR26.9)
      expect(toolRegistry.hasTool("skill:code-audit/audit")).toBe(false);

      // 2. Enable
      await manager.enable(skillId);
      const info2 = await manager.getSkillInfo(skillId);
      expect(info2?.state).toBe("enabled");
      expect(info2?.enabled).toBe(true);
      expect(info2?.active).toBe(false);

      // Invariant: Enabled alone does NOT mean tools are Active yet
      expect(toolRegistry.hasTool("skill:code-audit/audit")).toBe(false);

      // 3. Activate
      const tools = await manager.activate(skillId);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("skill:code-audit/audit");
      expect(tools[0].source).toBe("skill");
      expect(tools[0].runtime).toBe("execution");

      const info3 = await manager.getSkillInfo(skillId);
      expect(info3?.state).toBe("active");
      expect(info3?.active).toBe(true);

      // Invariant: Active tools ARE registered in ToolRegistry
      expect(toolRegistry.hasTool("skill:code-audit/audit")).toBe(true);

      // 4. Disable unregisters active tools immediately (§PR26.9)
      await manager.disable(skillId);
      expect(toolRegistry.hasTool("skill:code-audit/audit")).toBe(false);
      const info4 = await manager.getSkillInfo(skillId);
      expect(info4?.active).toBe(false);
      expect(info4?.enabled).toBe(false);

      // 5. Uninstall cleans up package and unregisters tools (§PR26.16)
      await installer.uninstall(skillId);
      expect(await manager.getSkillInfo(skillId)).toBeUndefined();
      expect(fs.existsSync(path.join(installBaseDir, "code-audit"))).toBe(false);
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
