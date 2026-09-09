import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import { PrismaConversationModelRepository } from "../conversations/prisma-conversation-model-repository.js";
import { createConversationId } from "@ai-desktop/shared";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("PrismaConversationModelRepository", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaConversationModelRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-convmodel-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaConversationModelRepository(db);
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

  it("sets and retrieves a conversation model selection", async () => {
    const convId = createConversationId();
    const ts = Date.now();

    const result = await repo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-flash",
      updatedAt: ts,
    });

    expect(result.conversationId).toBe(convId);
    expect(result.providerId).toBe("gemini");
    expect(result.modelId).toBe("gemini:gemini-2.5-flash");
    expect(result.profileId).toBeNull();

    const retrieved = await repo.getByConversationId(convId);
    expect(retrieved).toEqual(result);
  });

  it("returns null for conversations without a model selection", async () => {
    const convId = createConversationId();
    const result = await repo.getByConversationId(convId);
    expect(result).toBeNull();
  });

  it("upserts model selection for the same conversation", async () => {
    const convId = createConversationId();
    const ts = Date.now();

    await repo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-flash",
      updatedAt: ts,
    });

    const updated = await repo.set({
      conversationId: convId,
      providerId: "anthropic",
      modelId: "anthropic:claude-sonnet-4-20250514",
      profileId: "some-profile-ulid",
      updatedAt: ts + 1000,
    });

    expect(updated.providerId).toBe("anthropic");
    expect(updated.modelId).toBe("anthropic:claude-sonnet-4-20250514");
    expect(updated.profileId).toBe("some-profile-ulid");

    const retrieved = await repo.getByConversationId(convId);
    expect(retrieved?.providerId).toBe("anthropic");
  });

  it("stores canonical model IDs, not native vendor IDs", async () => {
    const convId = createConversationId();
    const ts = Date.now();

    await repo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-pro",
      updatedAt: ts,
    });

    const retrieved = await repo.getByConversationId(convId);
    expect(retrieved?.modelId).toBe("gemini:gemini-2.5-pro");
  });

  it("deletes a conversation model selection", async () => {
    const convId = createConversationId();
    const ts = Date.now();

    await repo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-flash",
      updatedAt: ts,
    });

    await repo.deleteByConversationId(convId);
    const result = await repo.getByConversationId(convId);
    expect(result).toBeNull();
  });

  it("delete is idempotent for conversations without a model selection", async () => {
    const convId = createConversationId();
    await expect(repo.deleteByConversationId(convId)).resolves.toBeUndefined();
  });

  it("lists all conversation model selections", async () => {
    const conv1 = createConversationId();
    const conv2 = createConversationId();
    const ts = Date.now();

    await repo.set({
      conversationId: conv1,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-flash",
      updatedAt: ts,
    });

    await repo.set({
      conversationId: conv2,
      providerId: "anthropic",
      modelId: "anthropic:claude-sonnet-4-20250514",
      updatedAt: ts + 1,
    });

    const all = await repo.listAll();
    const convIds = all.map((m) => m.conversationId);
    expect(convIds).toContain(conv1);
    expect(convIds).toContain(conv2);
  });

  it("persists model selections across database restart", async () => {
    const convId = createConversationId();
    const ts = Date.now();

    await repo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-flash-lite",
      updatedAt: ts,
    });

    await db.close();

    const db2 = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db2.initialize();
    const repo2 = new PrismaConversationModelRepository(db2);

    const recovered = await repo2.getByConversationId(convId);
    expect(recovered).not.toBeNull();
    expect(recovered!.modelId).toBe("gemini:gemini-2.5-flash-lite");

    await db2.close();
    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaConversationModelRepository(db);
  });
});
