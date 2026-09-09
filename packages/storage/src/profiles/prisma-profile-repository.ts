// PR22.5: packages/storage — PrismaProviderProfileRepository Implementation
//
// Invariants:
//   - Full CRUD backed by the Prisma ProviderProfileRecord model.
//   - Raw credentials are never stored; only credentialRef passes through.
//   - Canonical IDs (ProviderId, ModelId) are persisted as plain strings.
//   - All reads return plain data objects, never Prisma model instances.

import type { StorageDatabase } from "../client/database.js";
import type {
  CreateProfileData,
  ProviderProfileRepository,
  StoredProviderProfile,
  UpdateProfileData,
} from "./profile-repository.js";
import { StorageError } from "../events/prisma-event-repository.js";
import type { ProviderId } from "@ai-desktop/ai-core";

function toStoredProfile(row: {
  id: string;
  providerId: string;
  name: string;
  credentialRef: string | null;
  endpointUrl: string | null;
  organizationId: string | null;
  defaultModelId: string | null;
  enabled: boolean;
  createdAt: bigint;
  updatedAt: bigint;
}): StoredProviderProfile {
  return {
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    credentialRef: row.credentialRef,
    endpointUrl: row.endpointUrl,
    organizationId: row.organizationId,
    defaultModelId: row.defaultModelId,
    enabled: row.enabled,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaProviderProfileRepository implements ProviderProfileRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async create(data: CreateProfileData): Promise<StoredProviderProfile> {
    try {
      const row = await this._db.client.providerProfileRecord.create({
        data: {
          id: data.id,
          providerId: data.providerId,
          name: data.name,
          credentialRef: data.credentialRef ?? null,
          endpointUrl: data.endpointUrl ?? null,
          organizationId: data.organizationId ?? null,
          defaultModelId: data.defaultModelId ?? null,
          enabled: data.enabled,
          createdAt: BigInt(data.createdAt),
          updatedAt: BigInt(data.updatedAt),
        },
      });
      return toStoredProfile(row);
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2002") || errString.includes("Unique constraint failed")) {
        throw new StorageError(`Provider profile with id "${data.id}" already exists`, {
          cause: err,
        });
      }
      throw new StorageError(`Failed to create provider profile: ${errString}`, { cause: err });
    }
  }

  async getById(id: string): Promise<StoredProviderProfile | null> {
    const row = await this._db.client.providerProfileRecord.findUnique({
      where: { id },
    });
    return row ? toStoredProfile(row) : null;
  }

  async getByProviderId(providerId: ProviderId): Promise<StoredProviderProfile[]> {
    const rows = await this._db.client.providerProfileRecord.findMany({
      where: { providerId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toStoredProfile);
  }

  async listAll(): Promise<StoredProviderProfile[]> {
    const rows = await this._db.client.providerProfileRecord.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toStoredProfile);
  }

  async listEnabled(): Promise<StoredProviderProfile[]> {
    const rows = await this._db.client.providerProfileRecord.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toStoredProfile);
  }

  async update(id: string, data: UpdateProfileData): Promise<StoredProviderProfile> {
    const existing = await this._db.client.providerProfileRecord.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new StorageError(`Provider profile "${id}" not found`);
    }

    try {
      const row = await this._db.client.providerProfileRecord.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.credentialRef !== undefined && { credentialRef: data.credentialRef }),
          ...(data.endpointUrl !== undefined && { endpointUrl: data.endpointUrl }),
          ...(data.organizationId !== undefined && { organizationId: data.organizationId }),
          ...(data.defaultModelId !== undefined && { defaultModelId: data.defaultModelId }),
          ...(data.enabled !== undefined && { enabled: data.enabled }),
          updatedAt: BigInt(data.updatedAt),
        },
      });
      return toStoredProfile(row);
    } catch (err: unknown) {
      throw new StorageError(`Failed to update provider profile "${id}": ${String(err)}`, {
        cause: err,
      });
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this._db.client.providerProfileRecord.delete({
        where: { id },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return;
      }
      throw new StorageError(`Failed to delete provider profile "${id}": ${errString}`, {
        cause: err,
      });
    }
  }
}
