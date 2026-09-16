// PR39: packages/storage — PrismaAttachmentRepository Implementation
//
// Backed by the SQLite attachments table via StorageDatabase. Project
// scoping enforced on every read/write; deletes idempotent (P2025 success).

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type {
  AttachmentRepository,
  CreateAttachmentData,
  StoredAttachment,
} from "./attachment-repository.js";

interface AttachmentRow {
  attachmentId: string;
  projectId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  status: string;
  artifactId: string;
  createdAt: bigint;
  updatedAt: bigint;
}

function toStored(row: AttachmentRow): StoredAttachment {
  return {
    attachmentId: row.attachmentId,
    projectId: row.projectId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    status: row.status,
    artifactId: row.artifactId,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaAttachmentRepository implements AttachmentRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async createAttachment(data: CreateAttachmentData): Promise<StoredAttachment> {
    try {
      const row = await this._db.client.attachmentRecord.create({
        data: {
          attachmentId: data.attachmentId,
          projectId: data.projectId,
          filename: data.filename,
          mimeType: data.mimeType,
          sizeBytes: data.sizeBytes,
          checksumSha256: data.checksumSha256,
          status: data.status,
          artifactId: data.artifactId,
          createdAt: BigInt(data.createdAt),
          updatedAt: BigInt(data.updatedAt),
        },
      });
      return toStored(row as unknown as AttachmentRow);
    } catch (err) {
      throw new StorageError(
        `Failed to create attachment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getAttachmentById(attachmentId: string): Promise<StoredAttachment | null> {
    const row = await this._db.client.attachmentRecord.findUnique({
      where: { attachmentId },
    });
    return row ? toStored(row as unknown as AttachmentRow) : null;
  }

  async listAttachmentsByProject(projectId: string): Promise<StoredAttachment[]> {
    const rows = await this._db.client.attachmentRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => toStored(row as unknown as AttachmentRow));
  }

  async updateAttachmentStatus(attachmentId: string, status: string): Promise<StoredAttachment> {
    try {
      const row = await this._db.client.attachmentRecord.update({
        where: { attachmentId },
        data: { status, updatedAt: BigInt(Date.now()) },
      });
      return toStored(row as unknown as AttachmentRow);
    } catch (err) {
      throw new StorageError(
        `Failed to update attachment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async deleteAttachment(attachmentId: string, projectId: string): Promise<void> {
    const existing = await this._db.client.attachmentRecord.findUnique({
      where: { attachmentId },
    });
    if (!existing) {
      return;
    }
    if ((existing as unknown as AttachmentRow).projectId !== projectId) {
      throw new StorageError("Attachment belongs to another project");
    }
    try {
      await this._db.client.attachmentRecord.delete({ where: { attachmentId } });
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2025") {
        return;
      }
      throw new StorageError(
        `Failed to delete attachment: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
