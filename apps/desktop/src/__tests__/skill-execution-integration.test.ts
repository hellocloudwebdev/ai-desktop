import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  asSkillId,
  type PermissionDecisionResult,
  type PermissionManager,
} from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import {
  SkillInstaller,
  SkillManager,
  SkillToolRegistry,
  SkillToolExecutor,
  computeFileChecksum,
} from "@ai-desktop/skills";
import type { CreateSkillData, SkillRepository, StoredSkill } from "@ai-desktop/storage";
import { DefaultExecutionManager, LocalProcessSandboxProvider } from "@ai-desktop/execution";

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

class AllowAllPermissionManager implements PermissionManager {
  async check(): Promise<PermissionDecisionResult> {
    return { kind: "allow" };
  }
}

function createRealSkillFixture(dir: string, scriptBody: string) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const scriptPath = path.join(dir, "scripts", "analyze.js");
  fs.writeFileSync(scriptPath, scriptBody);
  const checksum = computeFileChecksum(scriptPath);

  fs.writeFileSync(path.join(dir, "SKILL.md"), "# Code Analyzer\n");

  const manifest = {
    id: "code-analyzer",
    name: "Code Analyzer",
    version: "1.0.0",
    description: "Analyzes code metrics",
    capabilities: ["execution"],
    entry: "SKILL.md",
    scripts: [
      {
        name: "analyze",
        path: "scripts/analyze.js",
        command: "node",
        description: "Executes analysis",
        parameters: {
          type: "object",
          properties: { metric: { type: "string" } },
          required: ["metric"],
        },
        checksum,
      },
    ],
  };

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { scriptPath, checksum };
}

describe("apps/desktop: Real Skill Script Execution through Sandbox (PR27.14, PR27.17)", () => {
  it("executes Skill script through ExecutionManager and SandboxProvider with integrity verified", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-skill-exec-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    const benignBody =
      'const args = JSON.parse(process.argv[2] || "{}"); console.log(`Metric result: ${args.metric}`);\n';
    createRealSkillFixture(sourceDir, benignBody);

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });
    const permissionManager = new AllowAllPermissionManager();

    // The real execution engine:
    const sandboxProvider = new LocalProcessSandboxProvider();
    const executionManager = new DefaultExecutionManager({ sandboxProvider, permissionManager });

    const executor = new SkillToolExecutor(toolRegistry, permissionManager, executionManager);

    try {
      // 1. Install, Enable, Activate
      await installer.install(sourceDir);
      const skillId = asSkillId("code-analyzer");
      await manager.enable(skillId);
      await manager.activate(skillId);

      // 2. Execute tool through the complete canonical pipeline:
      // Skill Tool -> ToolExecutor -> PermissionManager -> Checksum verification -> ExecutionManager -> SandboxProvider -> isolated process
      const result = await executor.execute("skill:code-analyzer/analyze", {
        metric: "cyclomatic_complexity",
      });

      expect(result.isError).toBe(false);
      expect(result.result).toContain("Metric result: cyclomatic_complexity");

      // 3. TAMPER WITH SCRIPT ON DISK (simulating unauthorized modification)
      const installedScriptPath = path.join(
        installBaseDir,
        "code-analyzer",
        "scripts",
        "analyze.js",
      );
      fs.writeFileSync(installedScriptPath, 'console.log("MALICIOUS MODIFICATION!");\n');

      // 4. Checksum verification fails BEFORE ExecutionManager is invoked (§PR26.13)
      await expect(
        executor.execute("skill:code-analyzer/analyze", { metric: "lines_of_code" }),
      ).rejects.toThrow(ValidationError);

      // 5. Restore original script body
      fs.writeFileSync(installedScriptPath, benignBody);

      // 6. Execution succeeds again!
      const restoredResult = await executor.execute("skill:code-analyzer/analyze", {
        metric: "restored_metric",
      });
      expect(restoredResult.isError).toBe(false);
      expect(restoredResult.result).toContain("Metric result: restored_metric");
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
