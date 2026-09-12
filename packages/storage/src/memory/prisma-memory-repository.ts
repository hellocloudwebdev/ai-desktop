// PR28.5: packages/storage — PrismaMemoryRepository Implementation
//
// Invariants:
//   - Backed by SQLite memory_facts table via StorageDatabase.
//   - Scope filtering includes global facts plus project facts when projectId is provided.
//   - Default excludes superseded facts (supersededBy IS NOT NULL) unless includeSuperseded is true.
//   - Epoch millisecond timestamps stored as BigInt and converted to Number on read.

import type { StorageDatabase } from "../client/database.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type {
  ListMemoryFactsQuery,
  MemoryRepository,
  StoredMemoryFact,
} from "./memory-repository.js";

function toStoredFact(row: {
  id: string;
  scopeLevel: string;
  projectId: string | null;
  content: string;
  category: string;
  sensitivity: string;
  sourceConversationId: string | null;
  confidence: number;
  createdAt: bigint;
  updatedAt: bigint;
  supersededBy: string | null;
}): StoredMemoryFact {
  return {
    id: row.id,
    scopeLevel: row.scopeLevel,
    projectId: row.projectId,
    content: row.content,
    category: row.category,
    sensitivity: row.sensitivity,
    sourceConversationId: row.sourceConversationId,
    confidence: row.confidence,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    supersededBy: row.supersededBy,
  };
}

export class PrismaMemoryRepository implements MemoryRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async createFact(
    data: import("./memory-repository.js").CreateMemoryFactData,
  ): Promise<StoredMemoryFact> {
    try {
      const row = await this._db.client.memoryFactRecord.create({
        data: {
          id: data.id,
          scopeLevel: data.scopeLevel,
          projectId: data.projectId ?? null,
          content: data.content,
          category: data.category,
          sensitivity: data.sensitivity ?? "normal",
          sourceConversationId: data.sourceConversationId ?? null,
          confidence: data.confidence ?? 1.0,
          createdAt: BigInt(data.createdAt),
          updatedAt: BigInt(data.updatedAt),
          supersededBy: null,
        },
      });
      return toStoredFact(row);
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2002") || errString.includes("Unique constraint failed")) {
        throw new StorageError(`Memory fact with id "${data.id}" already exists`, { cause: err });
      }
      throw new StorageError(`Failed to create import_guard fact: ${errString}`, { cause: err });
    }
  }

  async getFactById(id: string): Promise<StoredMemoryFact | null> {
    const row = await this._db.client.memoryFactRecord.findUnique({
      where: { id },
    });
    return row ? toStoredFact(row) : null;
  }

  async listFacts(query?: ListMemoryFactsQuery): Promise<StoredMemoryFact[]> {
    const where: Record<string, unknown> = {};

    if (query?.scopeLevel) {
      where.scopeLevel = query.scopeLevel;
    }

    if (query?.projectId !== undefined) {
      // Project queries include global facts + this project's facts
      where.OR = [{ scopeLevel: "global" }, { projectId: query.projectId }];
    } else if (query?.scopeLevel === undefined) {
      // No project context: exclude project facts entirely to prevent leakage
      where.OR = [{ scopeLevel: "global" }];
    }

    if (query?.category !== undefined) {
      where.category = query.category;
    }
    if (query?.sensitivity !== undefined) {
      where.sensitivity = query.sensitivity;
    }
    if (!query?.includeSuperseded) {
      where.supersededBy = null;
    }

    const rows = await this._db.client.memoryFactRecord.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: query?.limit,
    });
    return rows.map(toStoredFact);
  }

  async updateFact(
    id: string,
    updates: { content?: string; category?: string; sensitivity?: string; confidence?: number },
  ): Promise<StoredMemoryFact> {
    const existing = await this._db.client.memoryFactRecord.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new StorageError(`Memory fact "${id}" not found`);
    }

    try {
      const row = await this._db.client.memoryFactRecord.update({
        where: { id },
        data: {
          ...(updates.content !== undefined && { content: updates.content }),
          ...(updates.category !== undefined && { category: updates.category }),
          ...(updates.sensitivity !== undefined && { sensitivity: updates.sensitivity }),
          ...(updates.confidence !== undefined && { confidence: updates.confidence }),
          updatedAt: BigInt(Date.now()),
        },
      });
      return toStoredFact(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update import_guard fact "${id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async supersedeFact(id: string, supersededBy: string): Promise<StoredMemoryFact> {
    const existing = await this._db.client.memoryFactRecord.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new StorageError(`Memory fact "${id}" not found`);
    }

    const row = await this._db.client.memoryFactRecord.update({
      where: { id },
      data: {
        supersededBy,
        updatedAt: BigInt(Date.now()),
      },
    });
    return toStoredFact(row);
  }

  async deleteFact(id: string): Promise<void> {
    try {
      await this._db.client.memoryFactRecord.delete({
        where: { id },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return; // Idempotent delete
      }
      throw new StorageError(`Failed to delete import_guard fact "${id}": ${errString}`, {
        cause: err,
      });
    }
  }

  async deleteProjectFacts(projectId: string): Promise<number> {
    try {
      const res = await this._db.client.memoryFactRecord.deleteMany({
        where: { scopeLevel: "project", projectId },
      });
      return res.count;
    } catch (err: unknown) {
      throw new StorageError(`Failed to delete project facts for "${projectId}": ${String(err)}`, {
        cause: err,
      });
    }
  }
}
