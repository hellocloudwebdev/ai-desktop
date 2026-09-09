// PR22.6: packages/storage — PrismaConversationModelRepository Implementation
//
// Invariants:
//   - Upsert semantics: set() creates or replaces the model selection for a conversation.
//   - Canonical IDs stored directly, no translation to native vendor IDs.
//   - Delete is idempotent.

import type { StorageDatabase } from "../client/database.js";
import type {
  ConversationModelRepository,
  SetConversationModelData,
  StoredConversationModel,
} from "./conversation-model-repository.js";
import { StorageError } from "../events/prisma-event-repository.js";

function toStoredModel(row: {
  conversationId: string;
  providerId: string;
  modelId: string;
  profileId: string | null;
  updatedAt: bigint;
}): StoredConversationModel {
  return {
    conversationId: row.conversationId,
    providerId: row.providerId,
    modelId: row.modelId,
    profileId: row.profileId,
    updatedAt: Number(row.updatedAt),
  };
}

export class PrismaConversationModelRepository implements ConversationModelRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async set(data: SetConversationModelData): Promise<StoredConversationModel> {
    try {
      const row = await this._db.client.conversationModelRecord.upsert({
        where: { conversationId: data.conversationId },
        create: {
          conversationId: data.conversationId,
          providerId: data.providerId,
          modelId: data.modelId,
          profileId: data.profileId ?? null,
          updatedAt: BigInt(data.updatedAt),
        },
        update: {
          providerId: data.providerId,
          modelId: data.modelId,
          profileId: data.profileId ?? null,
          updatedAt: BigInt(data.updatedAt),
        },
      });
      return toStoredModel(row);
    } catch (err: unknown) {
      throw new StorageError(
        `Failed to set conversation model for "${data.conversationId}": ${String(err)}`,
        { cause: err },
      );
    }
  }

  async getByConversationId(conversationId: string): Promise<StoredConversationModel | null> {
    const row = await this._db.client.conversationModelRecord.findUnique({
      where: { conversationId },
    });
    return row ? toStoredModel(row) : null;
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    try {
      await this._db.client.conversationModelRecord.delete({
        where: { conversationId },
      });
    } catch (err: unknown) {
      const errString = String(err);
      if (errString.includes("P2025") || errString.includes("Record to delete does not exist")) {
        return;
      }
      throw new StorageError(
        `Failed to delete conversation model for "${conversationId}": ${errString}`,
        { cause: err },
      );
    }
  }

  async listAll(): Promise<StoredConversationModel[]> {
    const rows = await this._db.client.conversationModelRecord.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toStoredModel);
  }
}
