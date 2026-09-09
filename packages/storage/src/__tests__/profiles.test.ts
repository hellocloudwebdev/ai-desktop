import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import { PrismaProviderProfileRepository } from "../profiles/prisma-profile-repository.js";
import { StorageError } from "../events/prisma-event-repository.js";
import { generateUlid } from "@ai-desktop/shared";
import { asProviderId } from "@ai-desktop/ai-core";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("PrismaProviderProfileRepository", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaProviderProfileRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-profiles-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaProviderProfileRepository(db);
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

  it("creates and retrieves a provider profile by id", async () => {
    const id = generateUlid();
    const ts = Date.now();

    const created = await repo.create({
      id,
      providerId: "gemini",
      name: "Personal Gemini",
      credentialRef: "app/provider/gemini/api-key",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    expect(created.id).toBe(id);
    expect(created.providerId).toBe("gemini");
    expect(created.name).toBe("Personal Gemini");
    expect(created.credentialRef).toBe("app/provider/gemini/api-key");
    expect(created.enabled).toBe(true);

    const retrieved = await repo.getById(id);
    expect(retrieved).toEqual(created);
  });

  it("returns null for non-existent profile id", async () => {
    const result = await repo.getById(generateUlid());
    expect(result).toBeNull();
  });

  it("lists profiles by provider id", async () => {
    const id1 = generateUlid();
    const id2 = generateUlid();
    const ts = Date.now();

    await repo.create({
      id: id1,
      providerId: "anthropic",
      name: "Work Anthropic",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    await repo.create({
      id: id2,
      providerId: "anthropic",
      name: "Personal Anthropic",
      enabled: true,
      createdAt: ts + 1,
      updatedAt: ts + 1,
    });

    const profiles = await repo.getByProviderId(asProviderId("anthropic"));
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("lists only enabled profiles", async () => {
    const enabledId = generateUlid();
    const disabledId = generateUlid();
    const ts = Date.now();

    await repo.create({
      id: enabledId,
      providerId: "gemini",
      name: "Enabled Profile",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    await repo.create({
      id: disabledId,
      providerId: "gemini",
      name: "Disabled Profile",
      enabled: false,
      createdAt: ts + 1,
      updatedAt: ts + 1,
    });

    const enabled = await repo.listEnabled();
    const enabledIds = enabled.map((p) => p.id);
    expect(enabledIds).toContain(enabledId);
    expect(enabledIds).not.toContain(disabledId);
  });

  it("updates profile fields selectively", async () => {
    const id = generateUlid();
    const ts = Date.now();

    await repo.create({
      id,
      providerId: "gemini",
      name: "Original Name",
      credentialRef: "app/provider/gemini/key-1",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    const updated = await repo.update(id, {
      name: "Updated Name",
      defaultModelId: "gemini:gemini-2.5-flash",
      updatedAt: ts + 1000,
    });

    expect(updated.name).toBe("Updated Name");
    expect(updated.defaultModelId).toBe("gemini:gemini-2.5-flash");
    expect(updated.credentialRef).toBe("app/provider/gemini/key-1");
    expect(updated.updatedAt).toBe(ts + 1000);
  });

  it("throws StorageError when updating non-existent profile", async () => {
    await expect(
      repo.update(generateUlid(), { name: "Ghost", updatedAt: Date.now() }),
    ).rejects.toThrow(StorageError);
  });

  it("deletes a profile", async () => {
    const id = generateUlid();
    const ts = Date.now();

    await repo.create({
      id,
      providerId: "gemini",
      name: "To Delete",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    await repo.delete(id);
    const result = await repo.getById(id);
    expect(result).toBeNull();
  });

  it("delete is idempotent for non-existent ids", async () => {
    await expect(repo.delete(generateUlid())).resolves.toBeUndefined();
  });

  it("persists optional fields as null when omitted", async () => {
    const id = generateUlid();
    const ts = Date.now();

    const created = await repo.create({
      id,
      providerId: "anthropic",
      name: "Minimal Profile",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    expect(created.credentialRef).toBeNull();
    expect(created.endpointUrl).toBeNull();
    expect(created.organizationId).toBeNull();
    expect(created.defaultModelId).toBeNull();
  });

  it("stores canonical model IDs, not native vendor IDs", async () => {
    const id = generateUlid();
    const ts = Date.now();

    await repo.create({
      id,
      providerId: "gemini",
      name: "Canonical ID Test",
      defaultModelId: "gemini:gemini-2.5-flash",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    const retrieved = await repo.getById(id);
    expect(retrieved?.defaultModelId).toBe("gemini:gemini-2.5-flash");
  });

  it("persists profiles across database restart", async () => {
    const id = generateUlid();
    const ts = Date.now();

    await repo.create({
      id,
      providerId: "gemini",
      name: "Restart Recovery Profile",
      credentialRef: "app/provider/gemini/restart-key",
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });

    await db.close();

    const db2 = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db2.initialize();
    const repo2 = new PrismaProviderProfileRepository(db2);

    const recovered = await repo2.getById(id);
    expect(recovered).not.toBeNull();
    expect(recovered!.name).toBe("Restart Recovery Profile");
    expect(recovered!.credentialRef).toBe("app/provider/gemini/restart-key");

    await db2.close();
    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaProviderProfileRepository(db);
  });
});
