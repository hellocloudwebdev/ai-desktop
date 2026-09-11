import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  createConversationId,
  createMessageId,
  now,
  ok,
  type ConversationId,
  type Result,
} from "@ai-desktop/shared";
import {
  createEventId,
  type AIEvent,
  type ChatRequest,
  type MessageStartedEvent,
  type MessageDeltaEvent,
  type MessageCompletedEvent,
  type ModelDefinition,
  type ModelId,
} from "@ai-desktop/ai-core";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  AnthropicAdapter,
  type ProviderAdapter,
  type ProviderConfigError,
} from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import {
  StorageDatabase,
  PrismaEventRepository,
  asSecretRef,
  type EventRepository,
} from "@ai-desktop/storage";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { createTestChatService } from "./test-helpers.js";
import { IpcBatcher } from "../main/ipc/batcher.js";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";

class InMemoryEventRepository implements EventRepository {
  readonly events = new Map<ConversationId, AIEvent[]>();

  async append(event: Readonly<AIEvent>): Promise<void> {
    const list = this.events.get(event.conversationId) ?? [];
    if (list.some((e) => e.sequence === event.sequence)) {
      throw new Error(`Duplicate sequence: ${event.sequence}`);
    }
    list.push(event as AIEvent);
    this.events.set(event.conversationId, list);
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    return [...(this.events.get(conversationId) ?? [])];
  }
}

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

    for (let i = 0; i < 5; i++) {
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
        deltaText: `chunk${i} `,
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

describe("apps/desktop: Conversation End-to-End & Integration (PR16)", () => {
  it("executes typed IPC CHAT_SEND and validates Zod before ChatService execution (§39.9, §39.56)", async () => {
    const ipcRegistry = new IpcRegistry();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const provider = new MockStreamingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    registerIpcHandlers(ipcRegistry, { streamRegistry, chatService });

    const conversationId = createConversationId();

    // 1. Malformed input is rejected by Zod in main before ChatService (§39.9, §39.64)
    const malformedRes = await ipcRegistry.invokeCommand(IPC_CHANNELS.CHAT_SEND, {
      conversationId,
      content: "", // content cannot be empty
    });

    expect(malformedRes.ok).toBe(false);
    if (!malformedRes.ok) {
      expect(malformedRes.error.code).toBe("VALIDATION_ERROR");
      expect(malformedRes.error.message).toContain("content");
    }

    // Verify ChatService was not invoked: zero storage events
    expect(await storage.getByConversation(conversationId)).toHaveLength(0);

    // 2. Well-formed input is accepted and returns accepted: true
    const validRes = await ipcRegistry.invokeCommand<{ accepted: boolean; messageId: string }>(
      IPC_CHANNELS.CHAT_SEND,
      {
        requestId: "req-1",
        conversationId,
        content: "Hello AI",
      },
    );

    expect(validRes.ok).toBe(true);
    if (validRes.ok) {
      expect(validRes.value.accepted).toBe(true);
      expect(validRes.value.messageId).toBeDefined();
    }

    ipcRegistry.destroy();
  });

  it("pipes events from ChatService through EventBus to IPC Batcher (§39.1, §39.28, §39.57)", async () => {
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const provider = new MockStreamingProvider();
    const batcher = new IpcBatcher();

    // Wire EventBus -> IPC Batcher
    eventBus.subscribe((event) => {
      batcher.enqueue(event);
    });

    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const sentBatches: Array<{ channel: string; data: { events: AIEvent[] } }> = [];

    const mockWebContents = {
      isDestroyed: () => false,
      send: (channel: string, data: unknown) => {
        sentBatches.push({ channel, data: data as { events: AIEvent[] } });
      },
      once: () => {},
    } as unknown as Electron.WebContents;

    batcher.subscribe(conversationId, mockWebContents);

    const result = await chatService.sendMessage({
      conversationId,
      content: "Hello",
    });

    await result.completion;

    // Flush any pending events in the batcher
    batcher.flush(conversationId);

    // Events were delivered to webContents via CHAT_STREAM_BATCH
    expect(sentBatches.length).toBeGreaterThanOrEqual(1);
    expect(sentBatches[0].channel).toBe(IPC_CHANNELS.CHAT_STREAM_BATCH);

    const allEventsDelivered = sentBatches.flatMap((b) => b.data.events);
    expect(allEventsDelivered.some((e) => e.type === "message.created")).toBe(true);
    expect(allEventsDelivered.some((e) => e.type === "message.started")).toBe(true);
    expect(allEventsDelivered.some((e) => e.type === "message.delta")).toBe(true);
    expect(allEventsDelivered.some((e) => e.type === "message.completed")).toBe(true);

    batcher.destroy();
  });

  it("reconstructs conversation across application restarts from persisted events (§39.38, §39.61)", async () => {
    const storage = new InMemoryEventRepository();
    const provider = new MockStreamingProvider();
    const conversationId = createConversationId();

    // Session 1: Send a message and generate assistant response
    {
      const streamRegistry = new ActiveStreamRegistry();
      const eventBus = new EventBus();
      const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

      const res1 = await chatService.sendMessage({
        conversationId,
        content: "Turn 1: Say hello",
      });
      await res1.completion;

      // Send turn 2
      const res2 = await chatService.sendMessage({
        conversationId,
        content: "Turn 2: Say goodbye",
      });
      await res2.completion;

      // Teardown session 1
      streamRegistry.clear();
      eventBus.clear();
    }

    // Session 2: "Restart application" with fresh ChatService, streamRegistry, eventBus
    // pointing to the same persistent storage
    {
      const streamRegistry = new ActiveStreamRegistry();
      const eventBus = new EventBus();
      const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

      // Load conversation directly from SQLite WAL events (§39.39)
      const conv = await chatService.getConversation(conversationId);

      expect(conv.id).toBe(conversationId);
      // 4 messages: user 1, assistant 1, user 2, assistant 2
      expect(conv.messages).toHaveLength(4);
      expect(conv.messages[0].role).toBe("user");
      expect(conv.messages[1].role).toBe("assistant");
      expect(conv.messages[1].status).toBe("completed");
      expect(conv.messages[2].role).toBe("user");
      expect(conv.messages[3].role).toBe("assistant");
      expect(conv.messages[3].status).toBe("completed");

      // Verify sequence is strictly contiguous and ordered (§39.63)
      const storedEvents = await storage.getByConversation(conversationId);
      for (let i = 0; i < storedEvents.length; i++) {
        expect(storedEvents[i].sequence).toBe(i);
      }
    }
  });

  it("cancellation through IPC is idempotent (§39.65, §39.89)", async () => {
    const ipcRegistry = new IpcRegistry();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const provider = new MockStreamingProvider();
    const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

    registerIpcHandlers(ipcRegistry, { streamRegistry, chatService });

    const conversationId = createConversationId();
    const msgId = createMessageId();

    // Multiple rapid cancel calls are safe and do not throw (§39.65)
    const cancel1 = await ipcRegistry.invokeCommand(IPC_CHANNELS.CHAT_CANCEL, {
      conversationId,
      messageId: msgId,
    });
    const cancel2 = await ipcRegistry.invokeCommand(IPC_CHANNELS.CHAT_CANCEL, {
      conversationId,
      messageId: msgId,
    });

    expect(cancel1.ok).toBe(true);
    expect(cancel2.ok).toBe(true);

    ipcRegistry.destroy();
  });

  it("proves real SQLite WAL persistence and restart recovery (§39.38, §39.61, §39.62)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-chat-recovery-"));
    const tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    const conversationId = createConversationId();
    const provider = new MockStreamingProvider();

    try {
      // 1. Session 1: initialize real SQLite database and verify WAL mode (§39.62)
      const db1 = new StorageDatabase({
        url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
      });
      await db1.initialize();

      const journalModeRows =
        await db1.client.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode;");
      expect(journalModeRows[0].journal_mode.toLowerCase()).toBe("wal");

      const storage1 = new PrismaEventRepository(db1);
      const streamRegistry1 = new ActiveStreamRegistry();
      const eventBus1 = new EventBus();
      const chatService1 = createTestChatService({
        provider,
        streamRegistry: streamRegistry1,
        eventBus: eventBus1,
        storage: storage1,
      });

      const res = await chatService1.sendMessage({
        conversationId,
        content: "Durable message 1",
      });
      await res.completion;

      // Close session 1 database completely
      await db1.close();

      // 2. Session 2: "Restart application" - open brand new StorageDatabase on same SQLite file
      const db2 = new StorageDatabase({
        url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
      });
      await db2.initialize();

      const storage2 = new PrismaEventRepository(db2);
      const streamRegistry2 = new ActiveStreamRegistry();
      const eventBus2 = new EventBus();
      const chatService2 = createTestChatService({
        provider,
        streamRegistry: streamRegistry2,
        eventBus: eventBus2,
        storage: storage2,
      });

      // Reconstruct conversation from durable SQLite events (§39.38, §39.39)
      const recoveredConv = await chatService2.getConversation(conversationId);
      expect(recoveredConv.id).toBe(conversationId);
      expect(recoveredConv.messages).toHaveLength(2); // user + assistant
      expect(recoveredConv.messages[0].role).toBe("user");
      expect(recoveredConv.messages[1].role).toBe("assistant");
      expect(recoveredConv.messages[1].status).toBe("completed");

      await db2.close();
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore tmp cleanup error
      }
    }
  });

  it.skipIf(!process.env.ANTHROPIC_SMOKE_TEST)(
    "opt-in live Anthropic smoke test (ANTHROPIC_SMOKE_TEST=1) (§39.60)",
    async () => {
      const provider = new AnthropicAdapter();
      await provider.initialize({
        providerId: ANTHROPIC_PROVIDER_ID,
        credentialRef: asSecretRef("app/provider/anthropic/api-key"),
      });

      const storage = new InMemoryEventRepository();
      const streamRegistry = new ActiveStreamRegistry();
      const eventBus = new EventBus();
      const chatService = createTestChatService({ provider, streamRegistry, eventBus, storage });

      const conversationId = createConversationId();
      const res = await chatService.sendMessage({
        conversationId,
        content: "Say 'Hello PR16' in three words.",
      });

      await res.completion;

      const conv = await chatService.getConversation(conversationId);
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[1].status).toBe("completed");
    },
  );
});
