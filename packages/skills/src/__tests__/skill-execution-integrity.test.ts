import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  asSkillId,
  createExecutionId,
  type ExecutionManager,
  type ExecutionRequest,
  type ExecutionResult,
  type PermissionCheck,
  type PermissionDecisionResult,
  type PermissionManager,
} from "@ai-desktop/ai-core";
import { now, ValidationError } from "@ai-desktop/shared";
import { SkillInstaller } from "../core/skill-installer.js";
import { SkillManager } from "../core/skill-manager.js";
import { SkillToolRegistry } from "../core/tool-registry.js";
import { SkillToolExecutor } from "../core/skill-tool-executor.js";
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

class RecordingExecutionManager implements ExecutionManager {
  readonly requests: ExecutionRequest[] = [];
  public stdout = "execution output";
  public exitCode = 0;

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(request);
    return {
      executionId: request.id ?? createExecutionId(),
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: "",
      durationMs: 15,
      timedOut: false,
      timestamp: now(),
    };
  }
}

class MockPermissionManager implements PermissionManager {
  public decision: PermissionDecisionResult = { kind: "allow" };
  readonly checks: PermissionCheck[] = [];

  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push(request);
    return this.decision;
  }
}

function createSampleSkill(dir: string, initialScriptBody: string) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const scriptPath = path.join(dir, "scripts", "run.js");
  fs.writeFileSync(scriptPath, initialScriptBody);
  const checksum = computeFileChecksum(scriptPath);

  fs.writeFileSync(path.join(dir, "SKILL.md"), "# Test Skill\n");

  const manifest = {
    id: "test-integrity",
    name: "Integrity Test Skill",
    version: "1.0.0",
    description: "Tests checksum verification",
    capabilities: ["execution"],
    entry: "SKILL.md",
    scripts: [
      {
        name: "run",
        path: "scripts/run.js",
        command: "node",
        description: "Executes script",
        parameters: {
          type: "object",
          properties: { inputVal: { type: "string" } },
          required: ["inputVal"],
        },
        checksum,
      },
    ],
  };

  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { scriptPath, originalChecksum: checksum };
}

describe("packages/skills: Pre-Execution Checksum Verification & Security Boundaries (PR26.11, PR26.12, PR26.13)", () => {
  it("verifies script checksum immediately before execution and blocks execution on modification", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-integrity-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    const originalBody = 'console.log("Benign code");\n';
    createSampleSkill(sourceDir, originalBody);

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });
    const permissionManager = new MockPermissionManager();
    const executionManager = new RecordingExecutionManager();

    const executor = new SkillToolExecutor(toolRegistry, permissionManager, executionManager);

    try {
      // 1. Install, Enable, Activate
      const installRes = await installer.install(sourceDir);
      expect(installRes.ok).toBe(true);

      const skillId = asSkillId("test-integrity");
      await manager.enable(skillId);
      await manager.activate(skillId);

      // 2. Normal execution: checksum matches -> allowed!
      const toolName = "skill:test-integrity/run";
      const res1 = await executor.execute(toolName, { inputVal: "hello" });
      expect(res1.isError).toBe(false);
      expect(executionManager.requests).toHaveLength(1);

      // 3. TAMPER WITH SCRIPT ON DISK (simulating unauthorized modification)
      const installedScriptPath = path.join(installBaseDir, "test-integrity", "scripts", "run.js");
      fs.writeFileSync(installedScriptPath, 'console.log("MALICIOUS MODIFICATION!");\n');

      // 4. Execute again: CHECKSUM VERIFICATION IMMEDIATELY BLOCKS EXECUTION! (§PR26.13)
      await expect(executor.execute(toolName, { inputVal: "hello" })).rejects.toThrow(
        ValidationError,
      );

      // CRITICAL INVARIANT: ExecutionManager was NOT called for tampered script!
      expect(executionManager.requests).toHaveLength(1); // Still 1 from the first call!

      // 5. RESTORE ORIGINAL SCRIPT BODY
      fs.writeFileSync(installedScriptPath, originalBody);

      // 6. Execute again: original trust is restored!
      const res3 = await executor.execute(toolName, { inputVal: "hello" });
      expect(res3.isError).toBe(false);
      expect(executionManager.requests).toHaveLength(2); // Second successful call!
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("enforces canonical order: validation failure aborts before PermissionManager is invoked", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-val-order-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSampleSkill(sourceDir, 'console.log("OK");\n');

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });
    const permissionManager = new MockPermissionManager();
    const executionManager = new RecordingExecutionManager();

    const executor = new SkillToolExecutor(toolRegistry, permissionManager, executionManager);

    try {
      await installer.install(sourceDir);
      const skillId = asSkillId("test-integrity");
      await manager.enable(skillId);
      await manager.activate(skillId);

      // Invalid input (missing required 'inputVal')
      await expect(executor.execute("skill:test-integrity/run", {})).rejects.toThrow(
        ValidationError,
      );

      // Invariant: PermissionManager was NEVER checked because validation failed first!
      expect(permissionManager.checks).toHaveLength(0);
      expect(executionManager.requests).toHaveLength(0);
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("permission denial stops execution before ExecutionManager is invoked", async () => {
    const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-perm-order-"));
    const sourceDir = path.join(tmpBaseDir, "source");
    const installBaseDir = path.join(tmpBaseDir, "installed");

    createSampleSkill(sourceDir, 'console.log("OK");\n');

    const repository = new InMemorySkillRepository();
    const toolRegistry = new SkillToolRegistry();
    const installer = new SkillInstaller({ installBaseDir, repository });
    const manager = new SkillManager({ repository, toolRegistry });
    const permissionManager = new MockPermissionManager();
    permissionManager.decision = { kind: "deny", reason: "Blocked by user policy" };
    const executionManager = new RecordingExecutionManager();

    const executor = new SkillToolExecutor(toolRegistry, permissionManager, executionManager);

    try {
      await installer.install(sourceDir);
      const skillId = asSkillId("test-integrity");
      await manager.enable(skillId);
      await manager.activate(skillId);

      const res = await executor.execute("skill:test-integrity/run", { inputVal: "valid" });
      expect(res.isError).toBe(true);
      expect(res.result).toContain("Permission denied");

      // ExecutionManager was NOT invoked!
      expect(executionManager.requests).toHaveLength(0);
    } finally {
      try {
        fs.rmSync(tmpBaseDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
