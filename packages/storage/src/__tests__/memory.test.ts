import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import { PrismaMemoryRepository } from "../memory/prisma-memory-repository.js";
import { generateUlid } from "@ai-desktop/shared";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("PrismaMemoryRepository: Scoped Memory Fact Persistence", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaMemoryRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-memory-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaMemoryRepository(db);
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

  it("creates and retrieves a global import_guard fact", async () => {
    const id = generateUlid();
    const ts = Date.now();

    const created = await repo.createFact({
      id,
      scopeLevel: "global",
      content: "User prefers pnpm for package management.",
      category: "preference",
      confidence: 0.95,
      createdAt: ts,
      updatedAt: ts,
    });

    expect(created.id).toBe(id);
    expect(created.scopeLevel).toBe("global");
    expect(created.projectId).toBeNull();
    expect(created.supersededBy).toBeNull();

    const retrieved = await repo.getFactById(id);
    expect(retrieved).toEqual(created);
  });

  it("creates a project-scoped fact and lists it with global facts", async () => {
    const globalId = generateUlid();
    const projectId = generateUlid();
    const ts = Date.now();

    await repo.createFact({
      id: globalId,
      scopeLevel: "global",
      content: "User prefers TypeScript strict mode.",
      category: "preference",
      createdAt: ts,
      updatedAt: ts,
    });

    const projectFact = await repo.createFact({
      id: projectId,
      scopeLevel: "project",
      projectId: "project-alpha",
      content: "Project Alpha uses Turborepo with pnpm workspaces.",
      category: "project_context",
      createdAt: ts,
      updatedAt: ts,
    });

    expect(projectFact.projectId).toBe("project-alpha");

    const listed = await repo.listFacts({ projectId: "project-alpha" });
    const ids = listed.map((f) => f.id);
    expect(ids).toContain(globalId);
    expect(ids).toContain(projectId);
  });

  it("never leaks other project facts into a project query", async () => {
    const ts = Date.now();

    await repo.createFact({
      id: generateUlid(),
      scopeLevel: "project",
      projectId: "project-B",
      content: "Project B uses Vue with Nuxt.",
      category: "project_context",
      createdAt: ts,
      updatedAt: ts,
    });

    const reactFact = await repo.createFact({
      id: generateUlid(),
      scopeLevel: "project",
      projectId: "project-A",
      content: "Project A uses React with Vite.",
      category: "project_context",
      createdAt: ts,
      updatedAt: ts,
    });

    const listedA = await repo.listFacts({ projectId: "project-A" });
    const idsA = listedA.map((f) => f.id);
    expect(idsA).toContain(reactFact.id);
    expect(listedA.every((f) => f.projectId !== "project-B")).toBe(true);
  });

  it("excludes superseded facts from default retrieval", async () => {
    const oldId = generateUlid();
    const newId = generateUlid();
    const ts = Date.now();

    await repo.createFact({
      id: oldId,
      scopeLevel: "global",
      content: "User's preferred editor is VSCode.",
      category: "preference",
      createdAt: ts,
      updatedAt: ts,
    });

    await repo.createFact({
      id: newId,
      scopeLevel: "global",
      content: "User's preferred editor is Zed.",
      category: "preference",
      createdAt: ts,
      updatedAt: ts,
    });

    await repo.supersedeFact(oldId, newId);

    const defaultListed = await repo.listFacts({});
    expect(defaultListed.map((f) => f.id)).not.toContain(oldId);
    expect(defaultListed.map((f) => f.id)).toContain(newId);

    const withHistory = await repo.listFacts({ includeSuperseded: true });
    expect(withHistory.map((f) => f.id)).toContain(oldId);
  });

  it("updates fact content and tracks updatedAt", async () => {
    const id = generateUlid();
    const ts = Date.now();

    await repo.createFact({
      id,
      scopeLevel: "global",
      content: "User reviews code on Fridays.",
      category: "workflow",
      createdAt: ts,
      updatedAt: ts,
    });

    const updated = await repo.updateFact(id, {
      content: "User reviews code every Friday afternoon with the team.",
      confidence: 0.9,
    });

    expect(updated.content).toBe("User reviews code every Friday afternoon with the team.");
    expect(updated.confidence).toBe(0.9);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(ts);
  });

  it("deletes project facts on project deletion while preserving global memory", async () => {
    const ts = Date.now();
    const projectFactId = generateUlid();

    await repo.createFact({
      id: projectFactId,
      scopeLevel: "project",
      projectId: "project-doomed",
      content: "Doomed project uses legacy build scripts.",
      category: "project_context",
      createdAt: ts,
      updatedAt: ts,
    });

    const deleted = await repo.deleteProjectFacts("project-doomed");
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await repo.getFactById(projectFactId)).toBeNull();

    // Global memory survives project deletion
    const globals = await repo.listFacts({ scopeLevel: "global" });
    expect(globals.length).toBeGreaterThan(0);
  });

  it("persists facts across database restart", async () => {
    const id = generateUlid();
    const ts = Date.now();

    await repo.createFact({
      id,
      scopeLevel: "project",
      projectId: "project-restart",
      content: "Restart-surviving project convention note.",
      category: "project_context",
      createdAt: ts,
      updatedAt: ts,
    });

    await db.close();

    const db2 = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db2.initialize();
    const repo2 = new PrismaMemoryRepository(db2);

    const recovered = await repo2.getFactById(id);
    expect(recovered).not.toBeNull();
    expect(recovered!.content).toBe("Restart-surviving project convention note.");

    await db2.close();
    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaMemoryRepository(db);
  });
});
