// PR26.6: packages/storage — PrismaSkillRepository Implementation
//
// Invariants:
//   - Backed by SQLite skills table via StorageDatabase.
//   - Persists install path and checksum without embedding package blobs.
//   - Converts Prisma BigInt timestamps to epoch-millisecond Numbers.

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type { CreateSkillData, SkillRepository, StoredSkill } from "./skill-repository.js";

function toStoredSkill(row: {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  installPath: string;
  checksum: string;
  installedAt: bigint;
  updatedAt: bigint;
  enabled: boolean;
  projectId: string | null;
}): StoredSkill {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    source: row.source,
    installPath: row.installPath,
    checksum: row.checksum,
    installedAt: Number(row.installedAt),
    updatedAt: Number(row.updatedAt),
    enabled: row.enabled,
    projectId: row.projectId,
  };
}

export class PrismaSkillRepository implements SkillRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async saveSkill(data: CreateSkillData): Promise<StoredSkill> {
    try {
      const row = await this._db.client.skillRecord.upsert({
        where: { id: data.id },
        create: {
          id: data.id,
          name: data.name,
          version: data.version,
          description: data.description,
          source: data.source,
          installPath: data.installPath,
          checksum: data.checksum,
          installedAt: BigInt(data.installedAt),
          updatedAt: BigInt(data.updatedAt),
          enabled: data.enabled ?? false,
          projectId: data.projectId ?? null,
        },
        update: {
          name: data.name,
          version: data.version,
          description: data.description,
          source: data.source,
          installPath: data.installPath,
          checksum: data.checksum,
          updatedAt: BigInt(data.updatedAt),
          ...(data.enabled !== undefined && { enabled: data.enabled }),
          ...(data.projectId !== undefined && { projectId: data.projectId }),
        },
      });
      return toStoredSkill(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to save skill "${data.id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async getSkillById(id: string): Promise<StoredSkill | null> {
    const row = await this._db.client.skillRecord.findUnique({
      where: { id },
    });
    return row ? toStoredSkill(row) : null;
  }

  async listSkills(projectId?: string): Promise<StoredSkill[]> {
    const where: Record<string, unknown> = {};
    if (projectId !== undefined) {
      where.OR = [{ projectId }, { projectId: null }];
    }

    const rows = await this._db.client.skillRecord.findMany({
      where,
      orderBy: { installedAt: "asc" },
    });
    return rows.map(toStoredSkill);
  }

  async setSkillEnabled(id: string, enabled: boolean, projectId?: string): Promise<StoredSkill> {
    const existing = await this._db.client.skillRecord.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new StorageError(`Skill "${id}" not found`);
    }

    try {
      const row = await this._db.client.skillRecord.update({
        where: { id },
        data: {
          enabled,
          ...(projectId !== undefined && { projectId }),
          updatedAt: BigInt(Date.now()),
        },
      });
      return toStoredSkill(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update skill enabled status for "${id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async deleteSkill(id: string): Promise<void> {
    try {
      await this._db.client.skillRecord.delete({
        where: { id },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return; // Idempotent delete
      }
      throw new StorageError(`Failed to delete skill "${id}": ${errString}`, {
        cause: err,
      });
    }
  }
}
