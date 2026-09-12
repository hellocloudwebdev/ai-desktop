import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { asSkillId } from "@ai-desktop/ai-core";
import { SkillInstaller, SkillManager, SkillToolRegistry } from "@ai-desktop/skills";
import { computeFileChecksum } from "@ai-desktop/skills";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
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

function createSampleSkillPackage(dir: string, skillId: string) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });

  const scriptPath = path.join(dir, "scripts", "check.js");
  fs.writeFileSync(scriptPath, 'console.log("Passed check");\n');
  const checksum = computeFileChecksum(scriptPath);

  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${skillId}\nMain documentation.\n`);
  fs.writeFileSync(
    path.join(dir, "references", "guide.md"),
    "# Reference Guide\nDetailed instructions.\n",
  );

  const manifest = {
    id: skillId,
    name: "Code Reviewer",
    version: "1.0.0",
    description: "Sample review skill",
    capabilities: ["execution"],
    entry: "SKILL.md",
    references: ["references/guide.md"],
    scripts: [
      {
        name: "check",
        path: "scripts/check.js",
        command: "node",
        description: "Runs check",
        checksum,
      },
    ],
  };

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

describe("apps/desktop: Skills IPC Dispatch & Management (PR26.17)", () => {
  it("manages skill lifecycle over typed IPC (install -> enable -> get -> load-reference -> disable -> uninstall)", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ipc-skills-"));
    const sourceDir = path.join(tmpBaseDir, "source-pkg");
    const installBaseDir = path.join(tmpBaseDir, "installed-skills");

    createSampleSkillPackage(sourceDir, "code-reviewer");

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const skillInstaller = new SkillInstaller({
      installBaseDir,
      repository,
      onUninstall: (id) => toolRegistry.unregisterSkillTools(id),
    });
    const skillManager = new SkillManager({ repository, toolRegistry });

    const ipcRegistry = new IpcRegistry();
    registerIpcHandlers(ipcRegistry, { skillManager, skillInstaller });

    try {
      // 1. Install via IPC
      const installRes = await ipcRegistry.invokeCommand<{ skill: { id: string; name: string } }>(
        IPC_CHANNELS.SKILLS_INSTALL,
        { sourceDir },
      );
      expect(installRes.ok).toBe(true);
      if (installRes.ok) {
        expect(installRes.value.skill.id).toBe("code-reviewer");
        expect(installRes.value.skill.name).toBe("Code Reviewer");
      }

      // 2. List via IPC
      const listRes = await ipcRegistry.invokeCommand<{
        skills: Array<{ id: string; enabled: boolean }>;
      }>(IPC_CHANNELS.SKILLS_LIST, {});
      expect(listRes.ok).toBe(true);
      if (listRes.ok) {
        expect(listRes.value.skills.some((s) => s.id === "code-reviewer")).toBe(true);
      }

      // 3. Enable via IPC
      const enableRes = await ipcRegistry.invokeCommand<{ enabled: boolean }>(
        IPC_CHANNELS.SKILLS_ENABLE,
        { skillId: "code-reviewer" },
      );
      expect(enableRes.ok).toBe(true);
      if (enableRes.ok) {
        expect(enableRes.value.enabled).toBe(true);
      }

      // 4. Activate in manager and verify tools in registry
      await skillManager.activate(asSkillId("code-reviewer"));
      expect(toolRegistry.hasTool("skill:code-reviewer/check")).toBe(true);

      // 5. Load reference on demand via IPC
      const refRes = await ipcRegistry.invokeCommand<{ content: string }>(
        IPC_CHANNELS.SKILLS_REFERENCES_LOAD,
        {
          skillId: "code-reviewer",
          relativePath: "references/guide.md",
        },
      );
      expect(refRes.ok).toBe(true);
      if (refRes.ok) {
        expect(refRes.value.content).toContain("Reference Guide");
      }

      // 6. Disable via IPC -> unregisters tools
      const disableRes = await ipcRegistry.invokeCommand<{ disabled: boolean }>(
        IPC_CHANNELS.SKILLS_DISABLE,
        { skillId: "code-reviewer" },
      );
      expect(disableRes.ok).toBe(true);
      expect(toolRegistry.hasTool("skill:code-reviewer/check")).toBe(false);

      // 7. Uninstall via IPC -> removes files and metadata
      const uninstallRes = await ipcRegistry.invokeCommand<{ uninstalled: boolean }>(
        IPC_CHANNELS.SKILLS_UNINSTALL,
        { skillId: "code-reviewer" },
      );
      expect(uninstallRes.ok).toBe(true);

      const afterUninstall = await skillManager.getSkillInfo(asSkillId("code-reviewer"));
      expect(afterUninstall).toBeUndefined();
      expect(fs.existsSync(path.join(installBaseDir, "code-reviewer"))).toBe(false);
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
