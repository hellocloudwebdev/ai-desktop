import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import { PrismaExtensionRepository } from "../extensions/prisma-extension-repository.js";
import { PrismaExtensionProjectBindingRepository } from "../extensions/prisma-extension-project-binding-repository.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function makeManifest(id: string, version: string): string {
  return JSON.stringify({ id, version, capabilities: ["test"] });
}

describe("packages/storage: PrismaExtensionRepository (PR32)", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaExtensionRepository;
  let bindings: PrismaExtensionProjectBindingRepository;

  function openDatabase(dbPath: string): StorageDatabase {
    return new StorageDatabase({
      url: `file:${dbPath.replace(/\\/g, "/")}`,
    });
  }

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-extensions-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    // Template dev.db (created by prisma migrate dev) preserves the schema.
    // Resolved relative to the repo root so the test is portable across machines.
    const templateDb = path.resolve(__dirname, "../../../../prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = openDatabase(tmpDbPath);
    await db.initialize();
    repo = new PrismaExtensionRepository(db);
    bindings = new PrismaExtensionProjectBindingRepository(db);
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

  it("saves and retrieves extension metadata by ID", async () => {
    const ts = Date.now();
    const saved = await repo.saveExtension({
      id: "my-extension",
      name: "my-extension",
      version: "1.0.0",
      displayName: "My Extension",
      description: "A test extension",
      manifest: makeManifest("my-extension", "1.0.0"),
      manifestHash: "hash-001",
      lifecycle: "installed",
      trust: "untrusted",
      installPath: "/fake/extensions/my-extension",
      installedAt: ts,
      updatedAt: ts,
    });

    expect(saved.id).toBe("my-extension");
    expect(saved.lifecycle).toBe("installed");
    expect(saved.trust).toBe("untrusted");

    const fetched = await repo.getExtension("my-extension");
    expect(fetched).toEqual(saved);
  });

  it("lists all saved extensions", async () => {
    const ts = Date.now();
    await repo.saveExtension({
      id: "second-extension",
      name: "second-extension",
      version: "0.2.0",
      manifest: makeManifest("second-extension", "0.2.0"),
      manifestHash: "hash-002",
      lifecycle: "installed",
      trust: "untrusted",
      installedAt: ts,
      updatedAt: ts,
    });

    const all = await repo.listExtensions();
    const ids = all.map((e) => e.id);
    expect(ids).toContain("my-extension");
    expect(ids).toContain("second-extension");
  });

  it("updates lifecycle state", async () => {
    const updated = await repo.setLifecycle("my-extension", "enabled");
    expect(updated.lifecycle).toBe("enabled");

    const fetched = await repo.getExtension("my-extension");
    expect(fetched?.lifecycle).toBe("enabled");
  });

  it("updates trust state", async () => {
    const updated = await repo.setTrust("my-extension", "trusted");
    expect(updated.trust).toBe("trusted");

    const fetched = await repo.getExtension("my-extension");
    expect(fetched?.trust).toBe("trusted");
  });

  it("updates manifest hash", async () => {
    const updated = await repo.updateHash("my-extension", "hash-003");
    expect(updated.manifestHash).toBe("hash-003");

    const fetched = await repo.getExtension("my-extension");
    expect(fetched?.manifestHash).toBe("hash-003");
  });

  it("deletes an extension idempotently", async () => {
    const ts = Date.now();
    await repo.saveExtension({
      id: "temp-extension",
      name: "temp-extension",
      version: "0.1.0",
      manifest: makeManifest("temp-extension", "0.1.0"),
      manifestHash: "hash-temp",
      lifecycle: "installed",
      trust: "untrusted",
      installedAt: ts,
      updatedAt: ts,
    });

    await repo.deleteExtension("temp-extension");
    expect(await repo.getExtension("temp-extension")).toBeNull();

    // Idempotent second delete
    await expect(repo.deleteExtension("temp-extension")).resolves.toBeUndefined();
  });

  it("sets and retrieves project bindings", async () => {
    const binding = await bindings.setBinding("my-extension", "proj-1", true);
    expect(binding.extensionId).toBe("my-extension");
    expect(binding.projectId).toBe("proj-1");
    expect(binding.enabled).toBe(true);

    const fetched = await bindings.getBinding("my-extension", "proj-1");
    expect(fetched).toEqual(binding);

    // Toggle enabled flag via idempotent upsert
    const toggled = await bindings.setBinding("my-extension", "proj-1", false);
    expect(toggled.enabled).toBe(false);
    expect(await bindings.getBinding("my-extension", "proj-1")).toEqual(toggled);
  });

  it("lists bindings per extension with project isolation", async () => {
    await bindings.setBinding("my-extension", "proj-2", true);
    await bindings.setBinding("second-extension", "proj-1", true);

    const forExtension = await bindings.listBindingsForExtension("my-extension");
    const projectIds = forExtension.map((b) => b.projectId);
    expect(projectIds).toContain("proj-1");
    expect(projectIds).toContain("proj-2");
    expect(forExtension.every((b) => b.extensionId === "my-extension")).toBe(true);

    const forProject = await bindings.listBindingsForProject("proj-1");
    const extensionIds = forProject.map((b) => b.extensionId);
    expect(extensionIds).toContain("my-extension");
    expect(extensionIds).toContain("second-extension");
    expect(forProject.every((b) => b.projectId === "proj-1")).toBe(true);

    // proj-2 bindings must not leak into proj-1 listing
    expect(extensionIds).not.toContain("proj-2");
    const proj2 = await bindings.listBindingsForProject("proj-2");
    expect(proj2.every((b) => b.projectId === "proj-2")).toBe(true);
    expect(proj2.some((b) => b.extensionId === "second-extension")).toBe(false);
  });

  it("deletes all bindings for an extension", async () => {
    await bindings.deleteBindingsForExtension("my-extension");
    expect(await bindings.listBindingsForExtension("my-extension")).toEqual([]);
    expect(await bindings.getBinding("my-extension", "proj-1")).toBeNull();

    // Bindings for other extensions survive
    const surviving = await bindings.listBindingsForExtension("second-extension");
    expect(surviving.length).toBeGreaterThan(0);

    // Idempotent second delete
    await expect(bindings.deleteBindingsForExtension("my-extension")).resolves.toBeUndefined();
  });

  it("recovers persisted data across restart", async () => {
    const ts = Date.now();
    await repo.saveExtension({
      id: "restart-extension",
      name: "restart-extension",
      version: "3.0.0",
      manifest: makeManifest("restart-extension", "3.0.0"),
      manifestHash: "hash-restart",
      lifecycle: "enabled",
      trust: "trusted",
      installPath: "/fake/extensions/restart",
      installedAt: ts,
      updatedAt: ts,
    });
    await bindings.setBinding("restart-extension", "proj-restart", true);

    // Simulate restart: close and reopen the same database file
    await db.close();
    db = openDatabase(tmpDbPath);
    await db.initialize();
    repo = new PrismaExtensionRepository(db);
    bindings = new PrismaExtensionProjectBindingRepository(db);

    const recovered = await repo.getExtension("restart-extension");
    expect(recovered).not.toBeNull();
    expect(recovered?.version).toBe("3.0.0");
    expect(recovered?.lifecycle).toBe("enabled");

    const recoveredBinding = await bindings.getBinding("restart-extension", "proj-restart");
    expect(recoveredBinding).not.toBeNull();
    expect(recoveredBinding?.enabled).toBe(true);
  });
});
