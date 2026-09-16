// PR37: packages/storage — Document Repository Tests
//
// Covers create/get/list scoping, status persistence, chunk round-trip,
// cascade delete, cross-project isolation, and idempotent delete. Uses a
// file-backed tmp DB seeded with CREATE TABLE IF NOT EXISTS so the tests
// run without a global `prisma migrate` step.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUlid } from "@ai-desktop/shared";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { StorageDatabase } from "../../client/database.js";
import { PrismaDocumentRepository } from "../prisma-document-repository.js";
import type { CreateDocumentChunkData } from "../document-repository.js";

const CREATE_DOCUMENTS_SQL = `
CREATE TABLE IF NOT EXISTS "documents" (
    "documentId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "sourceFileSize" INTEGER NOT NULL,
    "title" TEXT,
    "author" TEXT,
    "pageCount" INTEGER,
    "language" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS "document_chunks" (
    "chunkId" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "locatorKind" TEXT NOT NULL,
    "locatorValue" TEXT NOT NULL,
    "locatorPage" INTEGER,
    "checksumSha256" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "documents_projectId_idx" ON "documents"("projectId");
CREATE INDEX IF NOT EXISTS "documents_projectId_status_idx" ON "documents"("projectId", "status");
CREATE INDEX IF NOT EXISTS "document_chunks_projectId_idx" ON "document_chunks"("projectId");
CREATE INDEX IF NOT EXISTS "document_chunks_documentId_idx" ON "document_chunks"("documentId");
CREATE INDEX IF NOT EXISTS "document_chunks_projectId_documentId_idx" ON "document_chunks"("projectId", "documentId");
`;

const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);

function makeDoc(projectId: string, overrides?: Record<string, unknown>) {
  const ts = Date.now();
  return {
    documentId: generateUlid(),
    projectId,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    checksumSha256: CHECKSUM_A,
    status: "ready",
    sourceType: "file",
    sourceFileName: "notes.txt",
    sourceFileSize: 12,
    createdAt: ts,
    updatedAt: ts,
    ...(overrides ?? {}),
  };
}

function makeChunk(
  documentId: string,
  projectId: string,
  ordinal: number,
): CreateDocumentChunkData {
  return {
    chunkId: generateUlid(),
    documentId,
    projectId,
    ordinal,
    text: `Chunk ${ordinal} text content here.`,
    locatorKind: "chunk",
    locatorValue: `chunk-${ordinal}`,
    locatorPage: null,
    checksumSha256: CHECKSUM_B,
  };
}

describe("PrismaDocumentRepository", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaDocumentRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-documents-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    for (const statement of CREATE_DOCUMENTS_SQL.split(";")) {
      const trimmed = statement.trim();
      if (trimmed) {
        await db.client.$executeRawUnsafe(`${trimmed};`);
      }
    }
    repo = new PrismaDocumentRepository(db);
  });

  afterAll(async () => {
    await db.close();
    try {
      fs.rmSync(path.dirname(tmpDbPath), { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });

  it("creates and retrieves a document by id", async () => {
    const data = makeDoc("project-a");
    const created = await repo.createDocument(data);
    expect(created.documentId).toBe(data.documentId);
    expect(created.status).toBe("ready");
    expect(created.title).toBeNull();

    const retrieved = await repo.getDocumentById(data.documentId);
    expect(retrieved).toEqual(created);
  });

  it("returns null for a missing document", async () => {
    expect(await repo.getDocumentById(generateUlid())).toBeNull();
  });

  it("lists documents scoped to one project", async () => {
    const a1 = makeDoc("project-list-a");
    const a2 = makeDoc("project-list-a", { name: "other.md", checksumSha256: "c".repeat(64) });
    const b1 = makeDoc("project-list-b");
    await repo.createDocument(a1);
    await repo.createDocument(a2);
    await repo.createDocument(b1);

    const listed = await repo.listDocumentsByProject("project-list-a");
    const ids = listed.map((d) => d.documentId);
    expect(ids).toContain(a1.documentId);
    expect(ids).toContain(a2.documentId);
    expect(ids).not.toContain(b1.documentId);
  });

  it("filters list by statuses", async () => {
    const ready = makeDoc("project-status", { status: "ready" });
    const failed = makeDoc("project-status", {
      status: "failed",
      name: "bad.pdf",
      checksumSha256: "d".repeat(64),
    });
    await repo.createDocument(ready);
    await repo.createDocument(failed);

    const listed = await repo.listDocumentsByProject("project-status", ["ready"]);
    const ids = listed.map((d) => d.documentId);
    expect(ids).toContain(ready.documentId);
    expect(ids).not.toContain(failed.documentId);
  });

  it("persists status transitions with error fields", async () => {
    const data = makeDoc("project-transition", { status: "processing" });
    await repo.createDocument(data);

    const updated = await repo.updateDocumentStatus(data.documentId, {
      status: "failed",
      errorCode: "malformed-content",
      errorMessage: "empty",
    });
    expect(updated.status).toBe("failed");
    expect(updated.errorCode).toBe("malformed-content");
    expect(updated.errorMessage).toBe("empty");

    const reread = await repo.getDocumentById(data.documentId);
    expect(reread?.status).toBe("failed");
  });

  it("persists metadata on status update", async () => {
    const data = makeDoc("project-meta", { status: "processing" });
    await repo.createDocument(data);

    const updated = await repo.updateDocumentStatus(data.documentId, {
      status: "ready",
      title: "My Doc",
      author: "Ada",
      pageCount: 3,
      language: "en",
    });
    expect(updated.title).toBe("My Doc");
    expect(updated.author).toBe("Ada");
    expect(updated.pageCount).toBe(3);
    expect(updated.language).toBe("en");
  });

  it("round-trips chunks ordered by ordinal", async () => {
    const data = makeDoc("project-chunks");
    await repo.createDocument(data);

    const stored = await repo.createChunks([
      makeChunk(data.documentId, "project-chunks", 1),
      makeChunk(data.documentId, "project-chunks", 0),
      makeChunk(data.documentId, "project-chunks", 2),
    ]);
    expect(stored).toHaveLength(3);

    const listed = await repo.listChunksByDocument(data.documentId, "project-chunks");
    expect(listed.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(listed[0]?.text).toContain("Chunk 0");
  });

  it("returns empty chunk list when nothing stored", async () => {
    const listed = await repo.listChunksByDocument(generateUlid(), "project-chunks");
    expect(listed).toEqual([]);
  });

  it("returns empty array for empty chunk batch", async () => {
    expect(await repo.createChunks([])).toEqual([]);
  });

  it("isolates chunks across projects", async () => {
    const docA = makeDoc("project-iso-a");
    const docB = makeDoc("project-iso-b");
    await repo.createDocument(docA);
    await repo.createDocument(docB);
    await repo.createChunks([makeChunk(docA.documentId, "project-iso-a", 0)]);
    await repo.createChunks([makeChunk(docB.documentId, "project-iso-b", 0)]);

    const listedA = await repo.listChunksByDocument(docA.documentId, "project-iso-a");
    expect(listedA).toHaveLength(1);
    // Same document id under a different project returns nothing.
    expect(await repo.listChunksByDocument(docA.documentId, "project-iso-b")).toEqual([]);
  });

  it("deleteDocument cascades chunks", async () => {
    const data = makeDoc("project-cascade");
    await repo.createDocument(data);
    await repo.createChunks([
      makeChunk(data.documentId, "project-cascade", 0),
      makeChunk(data.documentId, "project-cascade", 1),
    ]);

    await repo.deleteDocument(data.documentId, "project-cascade");
    expect(await repo.getDocumentById(data.documentId)).toBeNull();
    expect(await repo.listChunksByDocument(data.documentId, "project-cascade")).toEqual([]);
  });

  it("deleteDocument is idempotent for missing documents", async () => {
    await expect(repo.deleteDocument(generateUlid(), "project-cascade")).resolves.toBeUndefined();
  });

  it("deleteDocument rejects cross-project deletes", async () => {
    const data = makeDoc("project-owner");
    await repo.createDocument(data);
    await expect(repo.deleteDocument(data.documentId, "project-intruder")).rejects.toThrow();
    // Original still intact.
    expect(await repo.getDocumentById(data.documentId)).not.toBeNull();
  });

  it("deleteChunksByDocument returns the deleted count", async () => {
    const data = makeDoc("project-chunk-delete");
    await repo.createDocument(data);
    await repo.createChunks([
      makeChunk(data.documentId, "project-chunk-delete", 0),
      makeChunk(data.documentId, "project-chunk-delete", 1),
    ]);

    const count = await repo.deleteChunksByDocument(data.documentId, "project-chunk-delete");
    expect(count).toBe(2);
    expect(await repo.listChunksByDocument(data.documentId, "project-chunk-delete")).toEqual([]);
  });

  it("updateDocumentStatus throws for missing documents", async () => {
    await expect(repo.updateDocumentStatus(generateUlid(), { status: "ready" })).rejects.toThrow();
  });
});
