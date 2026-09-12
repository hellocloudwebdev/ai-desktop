import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import { PrismaSkillRepository } from "../skills/prisma-skill-repository.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("packages/storage: PrismaSkillRepository (PR26.6)", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaSkillRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-skills-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaSkillRepository(db);
  });

  afterAll(async () => {
    await db.close();
    try {
      const dir = path.dirname(tmpDbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });

  it("saves and retrieves skill metadata by ID", async () => {
    const ts = Date.now();
    const saved = await repo.saveSkill({
      id: "code-review",
      name: "Code Review Skill",
      version: "1.0.0",
      description: "Automated code reviewer",
      source: "local",
      installPath: "/fake/skills/code-review",
      checksum: "abcdef1234567890",
      installedAt: ts,
      updatedAt: ts,
      enabled: false,
    });

    expect(saved.id).toBe("code-review");
    expect(saved.name).toBe("Code Review Skill");
    expect(saved.enabled).toBe(false);

    const fetched = await repo.getSkillById("code-review");
    expect(fetched).toEqual(saved);
  });

  it("sets skill enabled state and supports project scoping", async () => {
    const ts = Date.now();
    await repo.saveSkill({
      id: "git-helper",
      name: "Git Helper",
      version: "1.0.0",
      description: "Git automation commands",
      source: "local",
      installPath: "/fake/skills/git-helper",
      checksum: "123456abcdef",
      installedAt: ts,
      updatedAt: ts,
      enabled: false,
    });

    const updated = await repo.setSkillEnabled("git-helper", true, "proj-1");
    expect(updated.enabled).toBe(true);
    expect(updated.projectId).toBe("proj-1");

    const listProj1 = await repo.listSkills("proj-1");
    expect(listProj1.some((s) => s.id === "git-helper")).toBe(true);
  });

  it("deletes a skill idempotently", async () => {
    const ts = Date.now();
    await repo.saveSkill({
      id: "temp-skill",
      name: "Temporary",
      version: "0.1.0",
      description: "To be deleted",
      source: "local",
      installPath: "/fake/skills/temp",
      checksum: "000000",
      installedAt: ts,
      updatedAt: ts,
    });

    await repo.deleteSkill("temp-skill");
    expect(await repo.getSkillById("temp-skill")).toBeNull();

    // Idempotent second delete
    await expect(repo.deleteSkill("temp-skill")).resolves.toBeUndefined();
  });
});
