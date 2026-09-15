// PR37: packages/storage — PrismaDocumentRepository Implementation
//
// Invariants:
//   - Backed by SQLite document_records/chunks tables via StorageDatabase.
//   - Project scoping is enforced on every read/write: cross-project access
//     returns null (reads) or throws StorageError (writes).
//   - Epoch millisecond timestamps stored as BigInt and converted to Number on read.
//   - Deletes are idempotent (P2025 treated as success).

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type {
  CreateDocumentChunkData,
  CreateDocumentData,
  DocumentRepository,
  StoredDocument,
  StoredDocumentChunk,
  UpdateDocumentStatusData,
} from "./document-repository.js";

interface DocumentRow {
  documentId: string;
  projectId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  status: string;
  sourceType: string;
  sourceFileName: string;
  sourceFileSize: number;
  title: string | null;
  author: string | null;
  pageCount: number | null;
  language: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: bigint;
  updatedAt: bigint;
}

interface ChunkRow {
  chunkId: string;
  documentId: string;
  projectId: string;
  ordinal: number;
  text: string;
  locatorKind: string;
  locatorValue: string;
  locatorPage: number | null;
  checksumSha256: string;
}

function toStoredDocument(row: DocumentRow): StoredDocument {
  return {
    documentId: row.documentId,
    projectId: row.projectId,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    status: row.status,
    sourceType: row.sourceType,
    sourceFileName: row.sourceFileName,
    sourceFileSize: row.sourceFileSize,
    title: row.title,
    author: row.author,
    pageCount: row.pageCount,
    language: row.language,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function toStoredChunk(row: ChunkRow): StoredDocumentChunk {
  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    projectId: row.projectId,
    ordinal: row.ordinal,
    text: row.text,
    locatorKind: row.locatorKind,
    locatorValue: row.locatorValue,
    locatorPage: row.locatorPage,
    checksumSha256: row.checksumSha256,
  };
}

export class PrismaDocumentRepository implements DocumentRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async createDocument(data: CreateDocumentData): Promise<StoredDocument> {
    try {
      const row = await this._db.client.documentRecord.create({
        data: {
          documentId: data.documentId,
          projectId: data.projectId,
          name: data.name,
          mimeType: data.mimeType,
          sizeBytes: data.sizeBytes,
          checksumSha256: data.checksumSha256,
          status: data.status,
          sourceType: data.sourceType,
          sourceFileName: data.sourceFileName,
          sourceFileSize: data.sourceFileSize,
          title: data.title ?? null,
          author: data.author ?? null,
          pageCount: data.pageCount ?? null,
          language: data.language ?? null,
          errorCode: null,
          errorMessage: null,
          createdAt: BigInt(data.createdAt),
          updatedAt: BigInt(data.updatedAt),
        },
      });
      return toStoredDocument(row as unknown as DocumentRow);
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2002") || errString.includes("Unique constraint failed")) {
        throw new StorageError(`Document with id "${data.documentId}" already exists`, {
          cause: err,
        });
      }
      throw new StorageError(`Failed to create document: ${errString}`, { cause: err });
    }
  }

  async getDocumentById(documentId: string): Promise<StoredDocument | null> {
    const row = await this._db.client.documentRecord.findUnique({
      where: { documentId },
    });
    return row ? toStoredDocument(row as unknown as DocumentRow) : null;
  }

  async listDocumentsByProject(projectId: string, statuses?: string[]): Promise<StoredDocument[]> {
    const rows = await this._db.client.documentRecord.findMany({
      where: {
        projectId,
        ...(statuses && statuses.length > 0 ? { status: { in: statuses } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return (rows as unknown as DocumentRow[]).map(toStoredDocument);
  }

  async updateDocumentStatus(
    documentId: string,
    data: UpdateDocumentStatusData,
  ): Promise<StoredDocument> {
    const existing = await this._db.client.documentRecord.findUnique({
      where: { documentId },
    });
    if (!existing) {
      throw new StorageError(`Document "${documentId}" not found`);
    }

    try {
      const row = await this._db.client.documentRecord.update({
        where: { documentId },
        data: {
          status: data.status,
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.author !== undefined ? { author: data.author } : {}),
          ...(data.pageCount !== undefined ? { pageCount: data.pageCount } : {}),
          ...(data.language !== undefined ? { language: data.language } : {}),
          ...(data.errorCode !== undefined ? { errorCode: data.errorCode } : {}),
          ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
          updatedAt: BigInt(Date.now()),
        },
      });
      return toStoredDocument(row as unknown as DocumentRow);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update document "${documentId}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async deleteDocument(documentId: string, projectId: string): Promise<void> {
    const existing = await this._db.client.documentRecord.findUnique({
      where: { documentId },
    });
    if (!existing) {
      return; // Idempotent delete
    }
    if ((existing as unknown as DocumentRow).projectId !== projectId) {
      throw new StorageError(`Document "${documentId}" does not belong to project "${projectId}"`);
    }
    try {
      await this._db.client.documentChunkRecord.deleteMany({
        where: { documentId, projectId },
      });
      await this._db.client.documentRecord.delete({
        where: { documentId },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return; // Idempotent delete
      }
      throw new StorageError(`Failed to delete document "${documentId}": ${errString}`, {
        cause: err,
      });
    }
  }

  async createChunks(chunks: CreateDocumentChunkData[]): Promise<StoredDocumentChunk[]> {
    if (chunks.length === 0) {
      return [];
    }
    try {
      await this._db.client.documentChunkRecord.createMany({
        data: chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          projectId: chunk.projectId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          locatorKind: chunk.locatorKind,
          locatorValue: chunk.locatorValue,
          locatorPage: chunk.locatorPage ?? null,
          checksumSha256: chunk.checksumSha256,
        })),
      });
      const rows = await this._db.client.documentChunkRecord.findMany({
        where: {
          chunkId: { in: chunks.map((chunk) => chunk.chunkId) },
        },
        orderBy: { ordinal: "asc" },
      });
      return (rows as unknown as ChunkRow[]).map(toStoredChunk);
    } catch (err: unknown) {
      throw new StorageError(`Failed to create document chunks: ${String(err)}`, { cause: err });
    }
  }

  async listChunksByDocument(
    documentId: string,
    projectId: string,
  ): Promise<StoredDocumentChunk[]> {
    const rows = await this._db.client.documentChunkRecord.findMany({
      where: { documentId, projectId },
      orderBy: { ordinal: "asc" },
    });
    return (rows as unknown as ChunkRow[]).map(toStoredChunk);
  }

  async deleteChunksByDocument(documentId: string, projectId: string): Promise<number> {
    try {
      const res = await this._db.client.documentChunkRecord.deleteMany({
        where: { documentId, projectId },
      });
      return res.count;
    } catch (err: unknown) {
      throw new StorageError(
        `Failed to delete chunks for document "${documentId}": ${String(err)}`,
        { cause: err },
      );
    }
  }
}
