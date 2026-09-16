// PR39: packages/storage — Attachment Repository Tests
//
// Covers create/get/list scoping, status updates, cross-project isolation,
// and idempotent delete. File-backed tmp DB seeded with CREATE TABLE so the
// tests run without a global migrate step.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUlid } from "@ai-desktop/shared";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { StorageDatabase } from "../../client/database.js";
import { PrismaAttachmentRepository } from "../prisma-attachment-repository.js";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS "attachments" (
    "attachmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    PRIMARY KEY ("attachmentId")
);
CREATE INDEX IF NOT EXISTS "attachments_projectId_idx" ON "attachments"("projectId");
`;

let dir: string;
let db: StorageDatabase;
let repo: PrismaAttachmentRepository;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-repo-"));
  db = new StorageDatabase({ url: `file:${path.join(dir, "test.db")}` });
  await db.initialize();
  const statements = CREATE_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await db.client.$executeRawUnsafe(sql);
  }
  repo = new PrismaAttachmentRepository(db);
});

afterAll(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeAttachment(projectId: string, overrides: Record<string, unknown> = {}) {
  const ts = Date.now();
  return {
    attachmentId: generateUlid(),
    projectId,
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    checksumSha256: "a".repeat(64),
    status: "available",
    artifactId: generateUlid(),
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe("PrismaAttachmentRepository", () => {
  it("creates and retrieves attachments", async () => {
    const created = await repo.createAttachment(makeAttachment("p1"));
    expect(created.filename).toBe("photo.png");
    const found = await repo.getAttachmentById(created.attachmentId);
    expect(found?.projectId).toBe("p1");
  });

  it("returns null for unknown ids", async () => {
    expect(await repo.getAttachmentById(generateUlid())).toBeNull();
  });

  it("lists only the requesting project", async () => {
    await repo.createAttachment(makeAttachment("pA"));
    await repo.createAttachment(makeAttachment("pB"));
    const listed = await repo.listAttachmentsByProject("pA");
    expect(listed.length).toBeGreaterThan(0);
    for (const item of listed) {
      expect(item.projectId).toBe("pA");
    }
  });

  it("updates status", async () => {
    const created = await repo.createAttachment(makeAttachment("p1", { status: "pending" }));
    const updated = await repo.updateAttachmentStatus(created.attachmentId, "available");
    expect(updated.status).toBe("available");
  });

  it("deletes idempotently", async () => {
    const created = await repo.createAttachment(makeAttachment("p1"));
    await repo.deleteAttachment(created.attachmentId, "p1");
    expect(await repo.getAttachmentById(created.attachmentId)).toBeNull();
    await repo.deleteAttachment(created.attachmentId, "p1");
    await repo.deleteAttachment(generateUlid(), "p1");
  });

  it("rejects cross-project delete", async () => {
    const created = await repo.createAttachment(makeAttachment("pA"));
    await expect(repo.deleteAttachment(created.attachmentId, "pB")).rejects.toThrow();
    expect(await repo.getAttachmentById(created.attachmentId)).not.toBeNull();
  });
});
