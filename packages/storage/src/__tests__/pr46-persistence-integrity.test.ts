// PR46: packages/storage — Persistence Integrity (adversarial)
//
// Locks: malformed rows rejected before DB writes, schema-version and
// allowlist enforcement, oversized-field truncation, event corruption
// surfacing. Fake DBs explode on write so a missing guard would persist.

import { describe, expect, it } from "vitest";
import { createConversationId, generateUlid, now } from "@ai-desktop/shared";
import { createEventId } from "@ai-desktop/ai-core";
import {
  PrismaSyncRecordRepository,
  SyncValidationError,
  type SyncRecordRow,
} from "../sync/sync-repository.js";
import {
  MAX_SCHEDULE_PROMPT_LENGTH,
  PrismaScheduledTaskRepository,
  ScheduledTaskValidationError,
} from "../scheduling/scheduled-task-repository.js";
import {
  DuplicateSequenceError,
  PrismaEventRepository,
  StorageError,
} from "../events/prisma-event-repository.js";
import type { StorageDatabase } from "../client/database.js";

function explodingSyncDb(capture?: { payload?: unknown }): StorageDatabase {
  const boom = async (): Promise<never> => {
    throw new Error("DB_TOUCHED");
  };
  const recordUpsert = async (args: { create: unknown }): Promise<unknown> => {
    if (capture) capture.payload = args.create;
    throw new Error("DB_TOUCHED");
  };
  return {
    client: {
      syncRecord: {
        upsert: recordUpsert,
        findUnique: boom,
        findMany: boom,
        delete: boom,
        deleteMany: boom,
      },
      syncCursor: { upsert: boom, findUnique: boom, findMany: boom, delete: boom },
      syncConflict: {
        upsert: boom,
        findUnique: boom,
        findMany: boom,
        delete: boom,
        deleteMany: boom,
      },
    },
  } as unknown as StorageDatabase;
}

function syncRow(overrides: Partial<SyncRecordRow> = {}): SyncRecordRow {
  return {
    recordId: generateUlid(),
    entityType: "app.settings",
    entityId: "entity-1",
    accountId: "acc-1",
    deviceId: "dev-1",
    version: 1,
    payloadJson: JSON.stringify({ theme: "dark" }),
    updatedAt: Date.now(),
    deletedAt: null,
    ...overrides,
  };
}

describe("persistence-integrity: sync rows validated before write", () => {
  it("rejects unknown entityType (allowlist, not open-ended)", async () => {
    const repo = new PrismaSyncRecordRepository(explodingSyncDb());
    await expect(repo.upsert(syncRow({ entityType: "schedule.run" }))).rejects.toThrow(
      SyncValidationError,
    );
    await expect(repo.upsert(syncRow({ entityType: "" }))).rejects.toThrow(SyncValidationError);
  });

  it("rejects bad versions and oversized payloads", async () => {
    const repo = new PrismaSyncRecordRepository(explodingSyncDb());
    await expect(repo.upsert(syncRow({ version: 0 }))).rejects.toThrow(SyncValidationError);
    await expect(repo.upsert(syncRow({ version: 1.5 }))).rejects.toThrow(SyncValidationError);
    await expect(repo.upsert(syncRow({ payloadJson: "x".repeat(65_536 + 1) }))).rejects.toThrow(
      SyncValidationError,
    );
  });

  it("rejects empty ids without touching the DB", async () => {
    const repo = new PrismaSyncRecordRepository(explodingSyncDb());
    await expect(repo.upsert(syncRow({ recordId: "" }))).rejects.toThrow(SyncValidationError);
    await expect(repo.upsert(syncRow({ entityId: "   " }))).rejects.toThrow(SyncValidationError);
  });
});

describe("persistence-integrity: oversized fields truncated (not rejected)", () => {
  it("truncates overlong schedule prompt to the durable bound", async () => {
    const capture: { payload?: unknown } = {};
    const repo = new PrismaScheduledTaskRepository({
      client: {
        scheduledTask: {
          upsert: async (args: { create: unknown }): Promise<unknown> => {
            capture.payload = args.create;
            return args.create;
          },
          findUnique: async () => null,
          findMany: async () => [],
        },
        scheduledRun: {
          upsert: async () => ({}),
          findUnique: async () => null,
          findMany: async () => [],
        },
      },
    } as unknown as StorageDatabase);
    const longPrompt = "p".repeat(MAX_SCHEDULE_PROMPT_LENGTH + 500);
    const row = {
      scheduleId: generateUlid(),
      projectId: "proj-a",
      name: "n",
      description: null,
      prompt: longPrompt,
      kind: "interval",
      configJson: "{}",
      timezone: "UTC",
      enabled: true,
      missedPolicy: "skip",
      overlapPolicy: "skip",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      missedCount: 0,
      schemaVersion: 1,
    };
    await repo.upsert(row);
    const written = capture.payload as { prompt: string };
    expect(written.prompt.length).toBe(MAX_SCHEDULE_PROMPT_LENGTH);
  });

  it("rejects empty schedule/project ids (fail-closed, not truncated)", async () => {
    const repo = new PrismaScheduledTaskRepository(explodingSyncDb() as unknown as StorageDatabase);
    const base = {
      scheduleId: generateUlid(),
      projectId: "proj-a",
      name: "n",
      description: null,
      prompt: "p",
      kind: "interval",
      configJson: "{}",
      timezone: "UTC",
      enabled: true,
      missedPolicy: "skip",
      overlapPolicy: "skip",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      missedCount: 0,
      schemaVersion: 1,
    };
    await expect(repo.upsert({ ...base, scheduleId: "" })).rejects.toThrow(
      ScheduledTaskValidationError,
    );
    await expect(repo.upsert({ ...base, projectId: "  " })).rejects.toThrow(
      ScheduledTaskValidationError,
    );
  });
});

describe("persistence-integrity: events (malformed rows + uniqueness)", () => {
  function eventDb(rows: unknown[], createBehavior?: (args: unknown) => Promise<unknown>) {
    return {
      client: {
        event: {
          create:
            createBehavior ??
            (async () => {
              throw new Error("unexpected create");
            }),
          findMany: async () => rows,
        },
      },
    } as unknown as StorageDatabase;
  }

  function validEvent(sequence = 0) {
    return {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
    };
  }

  it("rejects corrupted payload JSON on read (never returns half-parsed events)", async () => {
    const repo = new PrismaEventRepository(eventDb([{ id: "e1", payload: "{not-json" }]));
    await expect(repo.getByConversation(createConversationId())).rejects.toThrow(StorageError);
  });

  it("rejects schema-invalid stored events on read (schema-version enforcement)", async () => {
    const bad = { ...validEvent(0), schemaVersion: "one" };
    const repo = new PrismaEventRepository(eventDb([{ id: "e1", payload: JSON.stringify(bad) }]));
    await expect(repo.getByConversation(createConversationId())).rejects.toThrow(StorageError);
  });

  it("maps unique-constraint failures to DuplicateSequenceError on append", async () => {
    const repo = new PrismaEventRepository(
      eventDb([], async () => {
        throw new Error("Unique constraint failed on (conversationId, sequence) P2002");
      }),
    );
    await expect(repo.append(validEvent(0) as never)).rejects.toThrow(DuplicateSequenceError);
  });

  it("rejects null/invalid events on append (fail-closed)", async () => {
    const repo = new PrismaEventRepository(eventDb([]));
    await expect(repo.append(null as never)).rejects.toThrow(StorageError);
  });
});
