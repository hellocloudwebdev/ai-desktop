// PR46: packages/skills — Manifest & Activation Integrity (adversarial)
//
// Locks: malformed/oversized/tampered manifests rejected, hash mismatch
// blocks activation, silent-activation absent (enable required), capability
// enforcement via Active-only tool registration.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SkillManifestSchema } from "../core/skill-manifest.js";
import { validateSkillPackage } from "../core/skill-validator.js";
import { SkillManager } from "../core/skill-manager.js";
import { SkillToolRegistry } from "../core/tool-registry.js";
import type { SkillRepository, StoredSkill } from "@ai-desktop/storage";

let tmpRoot: string;
const tmpDirs: string[] = [];

function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writePackage(manifest: Record<string, unknown>, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "pkg-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

function validManifest(scriptContent = "console.log(1)"): Record<string, unknown> {
  return {
    id: "test-skill",
    name: "Test Skill",
    version: "1.0.0",
    description: "A valid skill.",
    capabilities: [],
    entry: "SKILL.md",
    references: [],
    examples: [],
    scripts: [
      {
        name: "run",
        path: "scripts/run.js",
        command: "node",
        description: "run it",
        parameters: { type: "object", properties: {} },
        checksum: checksumOf(scriptContent),
      },
    ],
  };
}

class FakeSkillRepo implements SkillRepository {
  private readonly skills = new Map<string, StoredSkill>();
  add(s: StoredSkill): void {
    this.skills.set(s.id, s);
  }
  async saveSkill(data: Parameters<SkillRepository["saveSkill"]>[0]): Promise<StoredSkill> {
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
    this.skills.set(s.id, s);
    return s;
  }
  async getSkillById(id: string): Promise<StoredSkill | null> {
    return this.skills.get(id) ?? null;
  }
  async listSkills(): Promise<StoredSkill[]> {
    return [...this.skills.values()];
  }
  async setSkillEnabled(id: string, enabled: boolean): Promise<StoredSkill> {
    const s = this.skills.get(id);
    if (!s) throw new Error("missing");
    const next = { ...s, enabled };
    this.skills.set(id, next);
    return next;
  }
  async deleteSkill(id: string): Promise<void> {
    this.skills.delete(id);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr46-skill-manifest-"));
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("skill manifest: malformed and oversized rejected", () => {
  it("rejects invalid semver, empty name, and overlong description", () => {
    expect(() => SkillManifestSchema.parse({ ...validManifest(), version: "v1" })).toThrow();
    expect(() => SkillManifestSchema.parse({ ...validManifest(), name: "" })).toThrow();
    expect(() =>
      SkillManifestSchema.parse({ ...validManifest(), description: "x".repeat(501) }),
    ).toThrow();
  });

  it("rejects malformed checksum shapes (not SHA-256 hex)", () => {
    const bad = validManifest();
    (bad.scripts as Array<Record<string, unknown>>)[0].checksum = "not-a-hash";
    expect(() => SkillManifestSchema.parse(bad)).toThrow(/Checksum/i);
  });

  it("rejects missing manifest.json and unparsable JSON", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    tmpDirs.push(dir);
    expect(validateSkillPackage(dir).ok).toBe(false);
    fs.writeFileSync(path.join(dir, "manifest.json"), "{not-json");
    expect(validateSkillPackage(dir).ok).toBe(false);
  });
});

describe("skill manifest: tamper and hash mismatch", () => {
  it("checksum mismatch blocks validation (tampered script)", () => {
    const dir = writePackage(validManifest("console.log(1)"), {
      "SKILL.md": "# s",
      "scripts/run.js": "console.log(EVIL)",
    });
    const result = validateSkillPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.message).toMatch(/checksum/i);
  });

  it("declared-but-missing reference file rejected", () => {
    const manifest = { ...validManifest(), references: ["refs/missing.md"] };
    const dir = writePackage(manifest, { "SKILL.md": "# s", "scripts/run.js": "console.log(1)" });
    expect(validateSkillPackage(dir).ok).toBe(false);
  });
});

describe("skill activation: no silent activation, Active-only tools", () => {
  it("activate without enable throws (never silently active)", async () => {
    const dir = writePackage(validManifest(), {
      "SKILL.md": "# s",
      "scripts/run.js": "console.log(1)",
    });
    const repo = new FakeSkillRepo();
    const nowMs = Date.now();
    repo.add({
      id: "test-skill",
      name: "Test Skill",
      version: "1.0.0",
      description: "d",
      source: "local",
      installPath: dir,
      checksum: "c",
      installedAt: nowMs,
      updatedAt: nowMs,
      enabled: false,
      projectId: null,
    });
    const manager = new SkillManager({ repository: repo, toolRegistry: new SkillToolRegistry() });
    await expect(manager.activate("test-skill" as never)).rejects.toThrow(/disabled/i);
    expect(manager.toolRegistry.listTools().length).toBe(0);
  });

  it("disable unregisters tools immediately (capability enforcement)", async () => {
    const dir = writePackage(validManifest(), {
      "SKILL.md": "# s",
      "scripts/run.js": "console.log(1)",
    });
    const repo = new FakeSkillRepo();
    const nowMs = Date.now();
    repo.add({
      id: "test-skill",
      name: "Test Skill",
      version: "1.0.0",
      description: "d",
      source: "local",
      installPath: dir,
      checksum: "c",
      installedAt: nowMs,
      updatedAt: nowMs,
      enabled: true,
      projectId: null,
    });
    const registry = new SkillToolRegistry();
    const manager = new SkillManager({ repository: repo, toolRegistry: registry });
    const tools = await manager.activate("test-skill" as never);
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(registry.listTools().length).toBeGreaterThanOrEqual(1);
    await manager.disable("test-skill" as never);
    expect(registry.listTools().length).toBe(0);
  });
});
