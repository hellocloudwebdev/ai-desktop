import { describe, expect, it } from "vitest";
import {
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
  type MessageCreatedEvent,
  type MessageFailedEvent,
  type MessageCompletedEvent,
  type ModelDefinition,
  type ModelId,
} from "@ai-desktop/ai-core";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  ModelNotFoundError,
  ProviderError,
  type ProviderAdapter,
  type ProviderConfigError,
} from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import type { EventRepository } from "@ai-desktop/storage";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { ChatService } from "../main/chat/chat-service.js";

class InMemoryEventRepository implements EventRepository {
  private readonly _events = new Map<ConversationId, AIEvent[]>();

  async append(event: Readonly<AIEvent>): Promise<void> {
    const list = this._events.get(event.conversationId) ?? [];
    // Check sequence uniqueness constraint (§39.21)
    if (list.some((e) => e.sequence === event.sequence)) {
      throw new Error(`Duplicate sequence: ${event.sequence}`);
    }
    list.push(event as AIEvent);
    this._events.set(event.conversationId, list);
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    return [...(this._events.get(conversationId) ?? [])];
  }
}

class FakeProviderAdapter implements ProviderAdapter {
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

  // Configurable stream generator
  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
    const assistantMsgId = createMessageId();

    // 1. Started
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

    // 2. Deltas
    for (const chunk of ["Hello", " ", "world", "!"]) {
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

    // 3. Completed
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

describe("apps/desktop: ChatService (Unit Tests)", () => {
  it("rejects unknown model IDs with ModelNotFoundError (§39.46)", async () => {
    const provider = new FakeProviderAdapter();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = new ChatService({ provider, streamRegistry, eventBus, storage });

    await expect(
      service.sendMessage({
        content: "Hello",
        modelId: "non-existent-model-id",
      }),
    ).rejects.toThrow(ModelNotFoundError);
  });

  it("registers stream in ActiveStreamRegistry before calling provider and cleans up in finally (§39.17, §39.25)", async () => {
    const provider = new FakeProviderAdapter();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = new ChatService({ provider, streamRegistry, eventBus, storage });

    const clientMessageId = createMessageId();

    const result = await service.sendMessage({
      content: "Hi",
      clientMessageId,
    });

    // While stream is running, message is registered
    expect(result.assistantMessageId).toBe(clientMessageId);

    await result.completion;

    // After completion, registry is cleanly removed (§39.25)
    expect(streamRegistry.has(clientMessageId)).toBe(false);
    expect(streamRegistry.size).toBe(0);
  });

  it("persists and publishes canonical events with strict sequence monotonicity (§39.20, §39.21)", async () => {
    const provider = new FakeProviderAdapter();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = new ChatService({ provider, streamRegistry, eventBus, storage });

    const busEvents: AIEvent[] = [];
    eventBus.subscribe((e) => {
      busEvents.push(e);
    });

    const conversationId = createConversationId();
    const result = await service.sendMessage({
      conversationId,
      content: "What is 2+2?",
    });

    await result.completion;

    // Verify storage events
    const storedEvents = await storage.getByConversation(conversationId);
    expect(storedEvents.length).toBeGreaterThanOrEqual(4); // user, started, deltas..., completed

    // Verify strict sequence order: 0, 1, 2, 3...
    for (let i = 0; i < storedEvents.length; i++) {
      expect(storedEvents[i].sequence).toBe(i);
    }

    // Verify EventBus received same events in order
    expect(busEvents.length).toBe(storedEvents.length);
    for (let i = 0; i < busEvents.length; i++) {
      expect(busEvents[i].type).toBe(storedEvents[i].type);
      expect(busEvents[i].sequence).toBe(i);
    }

    // User message created
    expect(storedEvents[0].type).toBe("message.created");
    expect((storedEvents[0] as MessageCreatedEvent).role).toBe("user");

    // Assistant message started, deltas, completed
    expect(storedEvents[1].type).toBe("message.started");
    expect(storedEvents[storedEvents.length - 1].type).toBe("message.completed");
  });

  it("cancels active generation and preserves partial transcript (§39.23, §39.24)", async () => {
    // Fake provider that delays between chunks
    class CancellableProvider extends FakeProviderAdapter {
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
          deltaText: "Partial response",
        } as MessageDeltaEvent;

        // Wait for cancellation signal
        while (!signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Signal was aborted: return cleanly
      }
    }

    const provider = new CancellableProvider();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = new ChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const result = await service.sendMessage({
      conversationId,
      content: "Explain quantum gravity",
    });

    // Let the first delta emit
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Cancel via service
    const cancelled = service.cancel(result.assistantMessageId);
    expect(cancelled).toBe(true);

    await result.completion;

    // Registry removed
    expect(streamRegistry.has(result.assistantMessageId)).toBe(false);

    // Verify stored events contain the partial delta AND message.cancelled
    const stored = await storage.getByConversation(conversationId);
    const types = stored.map((e) => e.type);
    expect(types).toContain("message.delta");
    expect(types).toContain("message.cancelled");
    expect(types).not.toContain("message.completed");

    // Project conversation to prove partial transcript preservation (§39.23)
    const conv = await service.getConversation(conversationId);
    expect(conv.messages).toHaveLength(2); // user + assistant
    const assistantMsg = conv.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.status).toBe("cancelled");
    expect(assistantMsg.content[0]).toEqual({
      type: "text",
      text: "Partial response",
    });
  });

  it("distinguishes provider failures from cancellations (§39.24)", async () => {
    class FailingProvider extends FakeProviderAdapter {
      override async *chat(): AsyncIterable<AIEvent> {
        throw new ProviderError("INTERNAL_ERROR", "Anthropic server error 500");
      }
    }

    const provider = new FailingProvider();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = new ChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const result = await service.sendMessage({
      conversationId,
      content: "Test failure",
    });

    await result.completion;

    const stored = await storage.getByConversation(conversationId);
    const lastEvent = stored[stored.length - 1];

    expect(lastEvent.type).toBe("message.failed");
    expect((lastEvent as MessageFailedEvent).error).toContain("500");
  });

  it("prevents duplicate terminal events (§39.66)", async () => {
    // Provider that emits message.completed inside generator
    const provider = new FakeProviderAdapter();
    const streamRegistry = new ActiveStreamRegistry();
    const eventBus = new EventBus();
    const storage = new InMemoryEventRepository();
    const service = new ChatService({ provider, streamRegistry, eventBus, storage });

    const conversationId = createConversationId();
    const result = await service.sendMessage({
      conversationId,
      content: "Terminal check",
    });

    await result.completion;

    const stored = await storage.getByConversation(conversationId);
    const completedCount = stored.filter((e) => e.type === "message.completed").length;
    const cancelledCount = stored.filter((e) => e.type === "message.cancelled").length;
    const failedCount = stored.filter((e) => e.type === "message.failed").length;

    // Exactly one terminal event in the entire stream
    expect(completedCount + cancelledCount + failedCount).toBe(1);
    expect(completedCount).toBe(1);
  });
});
