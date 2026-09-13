// PR32: packages/storage — PrismaExtensionProjectBindingRepository Implementation
//
// Invariants:
//   - Backed by SQLite extension_project_bindings table via StorageDatabase.
//   - Composite key (extensionId, projectId); upsert makes setBinding idempotent.
//   - Converts Prisma BigInt timestamps to epoch-millisecond Numbers.

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type {
  ExtensionProjectBindingRepository,
  StoredExtensionProjectBinding,
} from "./extension-project-binding-repository.js";

function toStoredBinding(row: {
  extensionId: string;
  projectId: string;
  enabled: boolean;
  createdAt: bigint;
  updatedAt: bigint;
}): StoredExtensionProjectBinding {
  return {
    extensionId: row.extensionId,
    projectId: row.projectId,
    enabled: row.enabled,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaExtensionProjectBindingRepository implements ExtensionProjectBindingRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async setBinding(
    extensionId: string,
    projectId: string,
    enabled: boolean,
  ): Promise<StoredExtensionProjectBinding> {
    try {
      const now = BigInt(Date.now());
      const row = await this._db.client.extensionProjectBindingRecord.upsert({
        where: { extensionId_projectId: { extensionId, projectId } },
        create: {
          extensionId,
          projectId,
          enabled,
          createdAt: now,
          updatedAt: now,
        },
        update: {
          enabled,
          updatedAt: now,
        },
      });
      return toStoredBinding(row);
    } catch (err: unknown) {
      throw new StorageError(
        `Failed to set binding for extension "${extensionId}" project "${projectId}": ${String(err)}`,
        { cause: err },
      );
    }
  }

  async getBinding(
    extensionId: string,
    projectId: string,
  ): Promise<StoredExtensionProjectBinding | null> {
    const row = await this._db.client.extensionProjectBindingRecord.findUnique({
      where: { extensionId_projectId: { extensionId, projectId } },
    });
    return row ? toStoredBinding(row) : null;
  }

  async listBindingsForExtension(extensionId: string): Promise<StoredExtensionProjectBinding[]> {
    const rows = await this._db.client.extensionProjectBindingRecord.findMany({
      where: { extensionId },
      orderBy: { projectId: "asc" },
    });
    return rows.map(toStoredBinding);
  }

  async listBindingsForProject(projectId: string): Promise<StoredExtensionProjectBinding[]> {
    const rows = await this._db.client.extensionProjectBindingRecord.findMany({
      where: { projectId },
      orderBy: { extensionId: "asc" },
    });
    return rows.map(toStoredBinding);
  }

  async deleteBindingsForExtension(extensionId: string): Promise<void> {
    try {
      await this._db.client.extensionProjectBindingRecord.deleteMany({
        where: { extensionId },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return; // Idempotent delete
      }
      throw new StorageError(
        `Failed to delete bindings for extension "${extensionId}": ${errString}`,
        {
          cause: err,
        },
      );
    }
  }
}
