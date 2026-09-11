import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createConversationId, createMessageId, now, ok, type Result } from "@ai-desktop/shared";
import {
  createEventId,
  projectMessages,
  textPart,
  type AIEvent,
  type ChatRequest,
  type MessageStartedEvent,
  type MessageDeltaEvent,
  type MessageCompletedEvent,
  type MessageCreatedEvent,
  type ModelDefinition,
  type ModelId,
} from "@ai-desktop/ai-core";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  ProviderError,
  type ProviderAdapter,
  type ProviderConfigError,
} from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import {
  DuplicateSequenceError,
  PrismaEventRepository,
  StorageDatabase,
  StorageError,
  type EventRepository,
} from "@ai-desktop/storage";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { createTestChatService } from "./test-helpers.js";
import { attachStorageConsumer } from "../main/index.js";

class MockStreamingProvider implements ProviderAdapter {
  readonly providerId = ANTHROPIC_PROVIDER_ID;
  private readonly _models = new Map<string, ModelDefinition>(
    ANTHROPIC_MODELS.map((m) => [m.id, m]),
  );

  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return [...this._models.values()];
  }
  async getModel(modelId: ModelId): Promise<ModelDefinition | undefined> {
    return this._models.get(modelId);
  }
  validateConfig(): Result<void, ProviderConfigError> {
    return ok(undefined);
  }
  supports(): boolean {
    return true;
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
    const assistantMsgId = createMessageId();

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: assistantMsgId,
      role: "assistant",
      content: [],
    } as MessageStartedEvent;

    for (const chunk of ["The ", "answer ", "is ", "42."]) {
      if (signal?.aborted) {
        return;
      }
      yield {
        eventId: createEventId(),
        conversationId: request.conversationId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: assistantMsgId,
        deltaText: chunk,
      } as MessageDeltaEvent;
    }

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: assistantMsgId,
      finishReason: "end_turn",
    } as MessageCompletedEvent;
  }
}

function createTempDb(): { tmpDir: string; tmpDbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-persist-test-"));
  const tmpDbPath = path.join(tmpDir, "test.db");

  const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
  if (fs.existsSync(templateDb)) {
    fs.copyFileSync(templateDb, tmpDbPath);
  }

  return {
    tmpDir,
    tmpDbPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore tmp cleanup error
      }
    },
  };
}

describe("apps/desktop: Persistence Integration & SQLite WAL Durability (PR17)", () => {
  it("persists entire stream lifecycle into SQLite WAL storage (§40.8, §40.29, §40.34)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    // Verify WAL mode is active (§40.29)
    const journalMode = await db.getJournalMode();
    expect(journalMode).toBe("wal");

    const storage = new PrismaEventRepository(db);
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const provider = new MockStreamingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId,
      content: "What is the ultimate answer?",
    });

    await res.completion;

    // Verify all canonical events are durably persisted throughout lifecycle
    const storedEvents = await storage.getByConversation(conversationId);
    expect(storedEvents.length).toBeGreaterThanOrEqual(6); // user, started, 4 deltas, completed

    const types = storedEvents.map((e) => e.type);
    expect(types[0]).toBe("message.created");
    expect(types[1]).toBe("message.started");
    expect(types.filter((t) => t === "message.delta").length).toBe(4);
    expect(types[types.length - 1]).toBe("message.completed");

    // Sequence numbers must be strictly contiguous (§40.9, §40.11, §40.37)
    for (let i = 0; i < storedEvents.length; i++) {
      expect(storedEvents[i].sequence).toBe(i);
    }

    // Replay projection produces coherent message read model
    const conv = await chatService.getConversation(conversationId);
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0].role).toBe("user");
    expect(conv.messages[1].role).toBe("assistant");
    expect(conv.messages[1].status).toBe("completed");
    expect(conv.messages[1].content[0]).toEqual({
      type: "text",
      text: "The answer is 42.",
    });

    await db.close();
    cleanup();
  });

  it("persists cancellation state and preserves partial transcript across replay (§40.24, §40.35)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    class SlowStreamingProvider extends MockStreamingProvider {
      override async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
        const assistantMsgId = createMessageId();
        yield {
          eventId: createEventId(),
          conversationId: request.conversationId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "message.started",
          category: "core",
          messageId: assistantMsgId,
          role: "assistant",
          content: [],
        } as MessageStartedEvent;

        yield {
          eventId: createEventId(),
          conversationId: request.conversationId,
          sequence: 0,
          schemaVersion: 1,
          timestamp: now(),
          type: "message.delta",
          category: "core",
          messageId: assistantMsgId,
          deltaText: "Partial uncompleted message",
        } as MessageDeltaEvent;

        while (!signal?.aborted) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    const storage = new PrismaEventRepository(db);
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const provider = new SlowStreamingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId,
      content: "Start streaming",
    });

    // Wait for delta to be emitted
    await new Promise((r) => setTimeout(r, 30));

    // Cancel active stream
    chatService.cancel(res.assistantMessageId);
    await res.completion;

    // Verify persisted events contain message.cancelled
    const stored = await storage.getByConversation(conversationId);
    const types = stored.map((e) => e.type);
    expect(types).toContain("message.delta");
    expect(types).toContain("message.cancelled");
    expect(types).not.toContain("message.completed");

    // Close and reopen database to prove restart recovery of cancelled stream (§40.24)
    await db.close();

    const db2 = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db2.initialize();
    const storage2 = new PrismaEventRepository(db2);
    const chatService2 = createTestChatService({
      provider,
      streamRegistry: new ActiveStreamRegistry(),
      eventBus: new EventBus(),
      storage: storage2,
    });

    const recovered = await chatService2.getConversation(conversationId);
    expect(recovered.messages[1].status).toBe("cancelled");
    expect(recovered.messages[1].content[0]).toEqual({
      type: "text",
      text: "Partial uncompleted message",
    });

    await db2.close();
    cleanup();
  });

  it("persists provider failure state and reconstructs failure on replay (§40.25, §40.36)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    class FailingProvider extends MockStreamingProvider {
      override async *chat(): AsyncIterable<AIEvent> {
        throw new ProviderError("INTERNAL_ERROR", "Anthropic overloaded (529)");
      }
    }

    const storage = new PrismaEventRepository(db);
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const provider = new FailingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId,
      content: "Trigger failure",
    });
    await res.completion;

    const stored = await storage.getByConversation(conversationId);
    expect(stored.some((e) => e.type === "message.failed")).toBe(true);

    const conv = await chatService.getConversation(conversationId);
    expect(conv.messages[1].status).toBe("failed");

    await db.close();
    cleanup();
  });

  it("rejects duplicate sequence writes via database constraint (§40.14, §40.38)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    const storage = new PrismaEventRepository(db);
    const conversationId = createConversationId();

    const event1: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("First")],
    };

    const event2: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId,
      sequence: 1, // duplicate sequence!
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Second")],
    };

    await storage.append(event1);

    // Second append must be rejected with DuplicateSequenceError (§40.38)
    await expect(storage.append(event2)).rejects.toThrow(DuplicateSequenceError);

    await db.close();
    cleanup();
  });

  it("allows same sequence numbers across independent conversations (§40.39)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    const storage = new PrismaEventRepository(db);
    const convA = createConversationId();
    const convB = createConversationId();

    const eventA: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: convA,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("A0")],
    };

    const eventB: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: convB,
      sequence: 0, // same sequence 0, but different conversation!
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("B0")],
    };

    await expect(storage.append(eventA)).resolves.not.toThrow();
    await expect(storage.append(eventB)).resolves.not.toThrow();

    expect(await storage.getByConversation(convA)).toHaveLength(1);
    expect(await storage.getByConversation(convB)).toHaveLength(1);

    await db.close();
    cleanup();
  });

  it("preserves exact schemaVersion and structural payload round-trip (§40.40, §40.41)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    const storage = new PrismaEventRepository(db);
    const conversationId = createConversationId();

    const originalEvent: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [
        { type: "text", text: "Complex user query" },
        { type: "image", mimeType: "image/png", data: "base64data", alt: "Diagram" },
      ],
    };

    await storage.append(originalEvent);

    const reloaded = await storage.getByConversation(conversationId);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].schemaVersion).toBe(1);
    expect(reloaded[0].eventId).toBe(originalEvent.eventId);
    expect((reloaded[0] as MessageCreatedEvent).content).toEqual(originalEvent.content);

    await db.close();
    cleanup();
  });

  it("maintains sequence continuity after application restart (§40.52, §40.53)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const conversationId = createConversationId();
    const provider = new MockStreamingProvider();

    // Session 1: Send turn 1 (creates events sequence 0..5)
    {
      const db1 = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db1.initialize();
      const storage1 = new PrismaEventRepository(db1);
      const chatService1 = createTestChatService({
        provider,
        streamRegistry: new ActiveStreamRegistry(),
        eventBus: new EventBus(),
        storage: storage1,
      });

      const res1 = await chatService1.sendMessage({
        conversationId,
        content: "Turn 1",
      });
      await res1.completion;

      const events1 = await storage1.getByConversation(conversationId);
      expect(events1.length).toBeGreaterThanOrEqual(6);
      expect(events1[events1.length - 1].sequence).toBe(events1.length - 1);

      await db1.close();
    }

    // Session 2: Fresh restart; send turn 2
    {
      const db2 = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db2.initialize();
      const storage2 = new PrismaEventRepository(db2);
      const chatService2 = createTestChatService({
        provider,
        streamRegistry: new ActiveStreamRegistry(),
        eventBus: new EventBus(),
        storage: storage2,
      });

      const res2 = await chatService2.sendMessage({
        conversationId,
        content: "Turn 2",
      });
      await res2.completion;

      // Verify sequence continued monotonically without resetting or colliding (§40.52)
      const allEvents = await storage2.getByConversation(conversationId);
      for (let i = 0; i < allEvents.length; i++) {
        expect(allEvents[i].sequence).toBe(i);
      }

      await db2.close();
    }

    cleanup();
  });

  it("guarantees live streaming and replay projections produce identical message state (§40.27, §40.45)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    const storage = new PrismaEventRepository(db);
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const provider = new MockStreamingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    const liveEvents: AIEvent[] = [];
    eventBus.subscribe((e) => {
      liveEvents.push(e);
    });

    const conversationId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId,
      content: "Equivalence test",
    });
    await res.completion;

    // 1. Live projection from streamed events
    const liveMessages = projectMessages(liveEvents);

    // 2. Replay projection from persisted SQLite events
    const persistedEvents = await storage.getByConversation(conversationId);
    const replayMessages = projectMessages(persistedEvents);

    // The two projections must be structurally identical (§40.27)
    expect(replayMessages).toEqual(liveMessages);

    await db.close();
    cleanup();
  });

  it("makes storage failure observable and deterministic (§40.15, §40.43)", async () => {
    class FaultyEventRepository implements EventRepository {
      async append(): Promise<void> {
        throw new StorageError("Disk I/O error writing event");
      }
      async getByConversation(): Promise<AIEvent[]> {
        return [];
      }
    }

    const storage = new FaultyEventRepository();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const provider = new MockStreamingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();

    // Storage failure on user message is NOT silently ignored (§40.15, §40.43)
    await expect(
      chatService.sendMessage({
        conversationId,
        content: "Will fail",
      }),
    ).rejects.toThrow(/Disk I\/O error/);

    // Active stream registry remains clean
    expect(streamRegistry.size).toBe(0);
  });

  it("attaches storage consumer to EventBus and safely ignores already-persisted events (§40.6, §40.18)", async () => {
    const { tmpDbPath, cleanup } = createTempDb();
    const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
    await db.initialize();

    const storage = new PrismaEventRepository(db);
    const eventBus = new EventBus();
    const conversationId = createConversationId();

    // Wire storage consumer to EventBus
    attachStorageConsumer(eventBus, storage);

    const event: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Bus event")],
    };

    // Publishing to EventBus automatically persists to storage
    await eventBus.publish(event);

    const stored = await storage.getByConversation(conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0].eventId).toBe(event.eventId);

    // Publishing again does not crash with unhandled DuplicateSequenceError
    await expect(eventBus.publish(event)).resolves.not.toThrow();

    await db.close();
    cleanup();
  });
});
