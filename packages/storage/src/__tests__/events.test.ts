import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import {
  DuplicateSequenceError,
  PrismaEventRepository,
} from "../events/prisma-event-repository.js";
import { createConversationId, createMessageId, createToolCallId, now } from "@ai-desktop/shared";
import {
  createEventId,
  textPart,
  type ConversationCreatedEvent,
  type MessageCompletedEvent,
  type MessageCreatedEvent,
  type MessageDeltaEvent,
  type ToolCallRequestedEvent,
} from "@ai-desktop/ai-core";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("PrismaEventRepository: Append-Only Immutable Event Storage", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaEventRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-events-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaEventRepository(db);
  });

  afterAll(async () => {
    await db.close();
    try {
      const dir = path.dirname(tmpDbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });

  it("appends and reads an immutable canonical event accurately", async () => {
    const convId = createConversationId();
    const eventId = createEventId();

    const event: ConversationCreatedEvent = {
      eventId,
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
      title: "Storage Foundation Test",
      metadata: { env: "test" },
    };

    await repo.append(event);

    const storedEvents = await repo.getByConversation(convId);
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]).toEqual(event);
  });

  it("returns events in strict ascending sequence order regardless of append order", async () => {
    const convId = createConversationId();

    const e1: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "chunk 1",
    };

    const e3: MessageCompletedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 3,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: createMessageId(),
    };

    const e2: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 2,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "chunk 2",
    };

    // Append out of order: 1 -> 3 -> 2
    await repo.append(e1);
    await repo.append(e3);
    await repo.append(e2);

    const results = await repo.getByConversation(convId);
    expect(results.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("fails and throws DuplicateSequenceError when inserting duplicate (conversationId, sequence)", async () => {
    const convId = createConversationId();

    const initialEvent: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Initial message")],
    };

    await repo.append(initialEvent);

    const duplicateEvent: MessageCreatedEvent = {
      eventId: createEventId(), // different eventId
      conversationId: convId, // same conversationId
      sequence: 0, // same sequence -> must fail!
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Conflicting message")],
    };

    await expect(repo.append(duplicateEvent)).rejects.toThrow(DuplicateSequenceError);

    // Verify initial event was not overwritten
    const stored = await repo.getByConversation(convId);
    expect(stored).toHaveLength(1);
    expect(stored[0].eventId).toBe(initialEvent.eventId);
  });

  it("permits identical sequence numbers across different conversations", async () => {
    const convA = createConversationId();
    const convB = createConversationId();

    const eventA: ConversationCreatedEvent = {
      eventId: createEventId(),
      conversationId: convA,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
      title: "Conversation A",
    };

    const eventB: ConversationCreatedEvent = {
      eventId: createEventId(),
      conversationId: convB,
      sequence: 0, // same sequence, different conversation!
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
      title: "Conversation B",
    };

    await repo.append(eventA);
    await repo.append(eventB);

    const storedA = await repo.getByConversation(convA);
    const storedB = await repo.getByConversation(convB);

    expect(storedA).toHaveLength(1);
    expect(storedB).toHaveLength(1);
    expect(storedA[0].conversationId).toBe(convA);
    expect(storedB[0].conversationId).toBe(convB);
  });

  it("returns empty array for conversations with no recorded events", async () => {
    const emptyConvId = createConversationId();
    const events = await repo.getByConversation(emptyConvId);
    expect(events).toEqual([]);
  });

  it("persists complex nested payloads with exact round-trip fidelity", async () => {
    const convId = createConversationId();

    const toolCallEvent: ToolCallRequestedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "tool.call.requested",
      category: "capability",
      toolCallId: createToolCallId(),
      toolName: "execute_script",
      toolSource: "skill",
      toolRuntime: "execution",
      input: {
        script: "console.log('nested test')",
        options: { timeout: 5000, env: { NODE_ENV: "test" } },
      },
    };

    await repo.append(toolCallEvent);

    const retrieved = await repo.getByConversation(convId);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]).toEqual(toolCallEvent);
  });

  it("persists events across process restarts (restart recovery test)", async () => {
    const convId = createConversationId();
    const eventId = createEventId();

    const event: ConversationCreatedEvent = {
      eventId,
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
      title: "Restart Recovery Session",
    };

    // Process 1 appends and closes
    await repo.append(event);
    await db.close();

    // Process 2 opens same database file and reads
    const db2 = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db2.initialize();
    const repo2 = new PrismaEventRepository(db2);

    const recovered = await repo2.getByConversation(convId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].eventId).toBe(eventId);
    expect(recovered[0].type).toBe("conversation.created");

    // Clean up process 2 and re-open primary db for test suite lifecycle
    await db2.close();
    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaEventRepository(db);
  });
});
