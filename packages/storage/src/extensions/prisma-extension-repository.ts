// PR32: packages/storage — PrismaExtensionRepository Implementation
//
// Invariants:
//   - Backed by SQLite extension_records table via StorageDatabase.
//   - Persists manifest JSON and lifecycle/trust state without embedding package blobs.
//   - Converts Prisma BigInt timestamps to epoch-millisecond Numbers.

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type {
  CreateExtensionData,
  ExtensionRepository,
  StoredExtension,
} from "./extension-repository.js";

function toStoredExtension(row: {
  id: string;
  name: string;
  version: string;
  displayName: string | null;
  description: string | null;
  manifest: string;
  manifestHash: string;
  lifecycle: string;
  trust: string;
  installPath: string | null;
  installedAt: bigint;
  updatedAt: bigint;
}): StoredExtension {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    displayName: row.displayName,
    description: row.description,
    manifest: row.manifest,
    manifestHash: row.manifestHash,
    lifecycle: row.lifecycle,
    trust: row.trust,
    installPath: row.installPath,
    installedAt: Number(row.installedAt),
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaExtensionRepository implements ExtensionRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async saveExtension(data: CreateExtensionData): Promise<StoredExtension> {
    try {
      const row = await this._db.client.extensionRecord.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          name: data.name,
          version: data.version,
          displayName: data.displayName ?? null,
          description: data.description ?? null,
          manifest: data.manifest,
          manifestHash: data.manifestHash,
          lifecycle: data.lifecycle,
          trust: data.trust,
          installPath: data.installPath ?? null,
          installedAt: BigInt(data.installedAt),
          updatedAt: BigInt(data.updatedAt),
        },
        update: {
          name: data.name,
          version: data.version,
          displayName: data.displayName ?? null,
          description: data.description ?? null,
          manifest: data.manifest,
          manifestHash: data.manifestHash,
          lifecycle: data.lifecycle,
          trust: data.trust,
          installPath: data.installPath ?? null,
          updatedAt: BigInt(data.updatedAt),
        },
      });
      return toStoredExtension(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to save extension "${data.id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async getExtension(id: string): Promise<StoredExtension | null> {
    const row = await this._db.client.extensionRecord.findUnique({
      where: { id },
    });
    return row ? toStoredExtension(row) : null;
  }

  async listExtensions(): Promise<StoredExtension[]> {
    const rows = await this._db.client.extensionRecord.findMany({
      orderBy: { installedAt: "asc" },
    });
    return rows.map(toStoredExtension);
  }

  private async requireExtension(id: string): Promise<void> {
    const existing = await this._db.client.extensionRecord.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new StorageError(`Extension "${id}" not found`);
    }
  }

  async setLifecycle(id: string, lifecycle: string): Promise<StoredExtension> {
    await this.requireExtension(id);
    try {
      const row = await this._db.client.extensionRecord.update({
        where: { id },
        data: {
          lifecycle,
          updatedAt: BigInt(Date.now()),
        },
      });
      return toStoredExtension(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update extension lifecycle for "${id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async setTrust(id: string, trust: string): Promise<StoredExtension> {
    await this.requireExtension(id);
    try {
      const row = await this._db.client.extensionRecord.update({
        where: { id },
        data: {
          trust,
          updatedAt: BigInt(Date.now()),
        },
      });
      return toStoredExtension(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update extension trust for "${id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async updateHash(id: string, manifestHash: string): Promise<StoredExtension> {
    await this.requireExtension(id);
    try {
      const row = await this._db.client.extensionRecord.update({
        where: { id },
        data: {
          manifestHash,
          updatedAt: BigInt(Date.now()),
        },
      });
      return toStoredExtension(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update extension hash for "${id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async deleteExtension(id: string): Promise<void> {
    try {
      await this._db.client.extensionRecord.delete({
        where: { id },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return; // Idempotent delete
      }
      throw new StorageError(`Failed to delete extension "${id}": ${errString}`, {
        cause: err,
      });
    }
  }
}
