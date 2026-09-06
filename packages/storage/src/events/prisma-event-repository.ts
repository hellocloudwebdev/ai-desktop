// PR8: packages/storage — PrismaEventRepository Implementation
//
// Invariants:
//   - Appends events immutably into SQLite.
//   - UNIQUE(conversationId, sequence) is enforced. Duplicate sequence insertion throws.
//   - getByConversation orders by sequence ASC strictly.
//   - Payloads are stored and parsed as deterministic JSON.
//   - SchemaVersion is preserved accurately.

import type { ConversationId } from "@ai-desktop/shared";
import type { AIEvent } from "@ai-desktop/ai-core";
import { AIEventSchema } from "@ai-desktop/ai-core";
import type { StorageDatabase } from "../client/database.js";
import type { EventRepository } from "./event-repository.js";

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class DuplicateSequenceError extends StorageError {
  readonly conversationId: string;
  readonly sequence: number;

  constructor(conversationId: string, sequence: number, options?: { cause?: unknown }) {
    super(
      `Duplicate event sequence: Event with sequence ${sequence} already exists in conversation "${conversationId}"`,
      options,
    );
    this.name = "DuplicateSequenceError";
    this.conversationId = conversationId;
    this.sequence = sequence;
  }
}

export class PrismaEventRepository implements EventRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async append(event: Readonly<AIEvent>): Promise<void> {
    if (!event || typeof event !== "object") {
      throw new StorageError("Cannot append null or invalid event");
    }

    // Extract taskId safely if present on the event
    const taskId = "taskId" in event && typeof event.taskId === "string" ? event.taskId : null;

    // Serialize payload cleanly: all properties except base fields
    const payloadJson = JSON.stringify(event);

    try {
      await this._db.client.event.create({
        data: {
          id: event.eventId,
          conversationId: event.conversationId,
          taskId,
          sequence: event.sequence,
          schemaVersion: event.schemaVersion,
          type: event.type,
          payload: payloadJson,
          createdAt: event.timestamp,
        },
      });
    } catch (err: unknown) {
      const errString = String(err);
      // Prisma unique constraint violation code is P2002
      if (errString.includes("P2002") || errString.includes("Unique constraint failed")) {
        throw new DuplicateSequenceError(event.conversationId, event.sequence, { cause: err });
      }
      throw new StorageError(`Failed to append event "${event.eventId}": ${errString}`, {
        cause: err,
      });
    }
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    if (!conversationId || typeof conversationId !== "string") {
      throw new StorageError(`Invalid conversationId: ${String(conversationId)}`);
    }

    const rows = await this._db.client.event.findMany({
      where: {
        conversationId,
      },
      orderBy: {
        sequence: "asc",
      },
    });

    if (rows.length === 0) {
      return [];
    }

    const events: AIEvent[] = [];
    for (const row of rows) {
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch (parseErr) {
        throw new StorageError(
          `Corrupted payload JSON in stored event "${row.id}" (conversation "${conversationId}"): ${String(parseErr)}`,
          { cause: parseErr },
        );
      }

      // Reconstruct and validate against canonical AIEventSchema
      const validated = AIEventSchema.safeParse(parsedPayload);
      if (!validated.success) {
        throw new StorageError(
          `Stored event "${row.id}" failed canonical AIEvent schema validation: ${validated.error.message}`,
          { cause: validated.error },
        );
      }

      events.push(validated.data as AIEvent);
    }

    return events;
  }
}
