// PR16: apps/desktop — Main Chat Service
//
// Invariants (Step 39):
//   1. Accepts canonical chat input; validates model against provider.
//   2. Reconstructs authoritative conversation context from persisted events.
//   3. Emits canonical user message event to storage and EventBus.
//   4. Registers stream in ActiveStreamRegistry BEFORE calling provider.
//   5. Pass AbortSignal down to ProviderAdapter for cooperative cancellation.
//   6. Publishes canonical events through EventBus; EventBus routes to IPC Batcher.
//   7. Persists every canonical event to EventRepository in monotonic sequence order.
//   8. Exactly one terminal lifecycle event per stream (no duplicate terminal events).
//   9. Stream cleanup (registry.remove) runs in a finally block.
//  10. Distinguishes cancellation from provider errors.
//  11. Preserves partial transcripts upon cancellation.

import {
  BaseError,
  createConversationId,
  createMessageId,
  now,
  type ConversationId,
  type MessageId,
} from "@ai-desktop/shared";
import {
  createEventId,
  projectConversation,
  projectMessages,
  textPart,
  type AIEvent,
  type ChatMessageInput,
  type ChatRequest,
  type Conversation,
  type Message,
  type MessageCreatedEvent,
  type MessageFailedEvent,
  type MessageCancelledEvent,
  type MessageCompletedEvent,
  type ModelId,
} from "@ai-desktop/ai-core";
import { ANTHROPIC_MODELS, ModelNotFoundError, type ProviderAdapter } from "@ai-desktop/providers";
import type { EventBus } from "@ai-desktop/agent-runtime";
import type { EventRepository } from "@ai-desktop/storage";
import { isTerminalEvent } from "../ipc/batcher.js";
import type { ActiveStreamRegistry } from "./active-stream-registry.js";
import type { ModelSelectionService } from "./model-selection-service.js";

export interface SendMessageInput {
  conversationId?: string;
  content: string;
  clientMessageId?: string;
  modelId?: string;
}

export interface SendMessageResult {
  conversationId: ConversationId;
  userMessageId: MessageId;
  assistantMessageId: MessageId;
  completion: Promise<void>;
}

export interface ChatServiceDependencies {
  provider?: ProviderAdapter;
  modelSelectionService?: ModelSelectionService;
  streamRegistry: ActiveStreamRegistry;
  eventBus: EventBus;
  storage: EventRepository;
  defaultModelId?: ModelId;
}

export class ChatService {
  private readonly _provider?: ProviderAdapter;
  private readonly _modelSelectionService?: ModelSelectionService;
  private readonly _streamRegistry: ActiveStreamRegistry;
  private readonly _eventBus: EventBus;
  private readonly _storage: EventRepository;
  private readonly _defaultModelId: ModelId;

  constructor(deps: ChatServiceDependencies) {
    this._provider = deps.provider;
    this._modelSelectionService = deps.modelSelectionService;
    this._streamRegistry = deps.streamRegistry;
    this._eventBus = deps.eventBus;
    this._storage = deps.storage;
    this._defaultModelId = deps.defaultModelId ?? ANTHROPIC_MODELS[0].id;
  }

  get provider(): ProviderAdapter {
    if (this._provider) {
      return this._provider;
    }
    if (this._modelSelectionService) {
      const providers = this._modelSelectionService.registry.listProviders();
      if (providers.length > 0) {
        return providers[0].adapter;
      }
    }
    throw new Error("No provider adapter available in ChatService");
  }

  get modelSelectionService(): ModelSelectionService | undefined {
    return this._modelSelectionService;
  }

  get streamRegistry(): ActiveStreamRegistry {
    return this._streamRegistry;
  }

  get eventBus(): EventBus {
    return this._eventBus;
  }

  get storage(): EventRepository {
    return this._storage;
  }

  /**
   * Reconstructs the canonical Conversation read model from persisted events.
   * Enables restart recovery directly from SQLite WAL storage.
   */
  async getConversation(conversationId: ConversationId): Promise<Conversation> {
    const events = await this._storage.getByConversation(conversationId);
    return projectConversation(events, conversationId);
  }

  /**
   * Reconstructs the canonical Message[] read model from persisted events.
   */
  async getMessages(conversationId: ConversationId): Promise<readonly Message[]> {
    const events = await this._storage.getByConversation(conversationId);
    return projectMessages(events);
  }

  /**
   * Cancels an active stream for the given message ID.
   * Returns true if an active stream was found and aborted, false otherwise.
   */
  cancel(messageId: MessageId): boolean {
    return this._streamRegistry.abort(messageId, "User requested cancellation");
  }

  /**
   * Sends a user message, publishes events, and streams assistant generation.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const conversationId: ConversationId = (input.conversationId ??
      createConversationId()) as ConversationId;
    const userMessageId: MessageId = createMessageId();
    const assistantMessageId: MessageId = (input.clientMessageId ?? createMessageId()) as MessageId;

    // 1. Model & Provider resolution (§42 / PR22.8)
    let adapter: ProviderAdapter;
    let modelId: ModelId;

    if (this._modelSelectionService) {
      const route = await this._modelSelectionService.resolveForConversation(
        conversationId,
        input.modelId,
      );
      adapter = route.adapter;
      modelId = route.model.id;
    } else if (this._provider) {
      modelId = (input.modelId ?? this._defaultModelId) as ModelId;
      const modelDef = await this._provider.getModel(modelId);
      if (!modelDef) {
        throw new ModelNotFoundError(modelId, { providerId: this._provider.providerId });
      }
      adapter = this._provider;
    } else {
      throw new Error("ChatService requires either provider or modelSelectionService");
    }

    // 2. Load historical events to maintain monotonic sequence ordering (§39.21)
    const historicalEvents = await this._storage.getByConversation(conversationId);
    let nextSequence =
      historicalEvents.length > 0 ? Math.max(...historicalEvents.map((e) => e.sequence)) + 1 : 0;

    // 3. Emit and persist canonical user message event (§39.14)
    const userEvent: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId,
      sequence: nextSequence++,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: userMessageId,
      role: "user",
      content: [textPart(input.content)],
    };

    await this._storage.append(userEvent);
    await this._eventBus.publish(userEvent);

    // 4. Project conversation state to construct canonical ChatRequest (§39.15, §39.16)
    const allEventsSoFar = [...historicalEvents, userEvent];
    const projectedConv = projectConversation(allEventsSoFar, conversationId);

    const messages: ChatMessageInput[] = projectedConv.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
    }));

    const chatRequest: ChatRequest = {
      conversationId,
      modelId,
      messages,
    };

    // 5. Register in ActiveStreamRegistry BEFORE calling provider (§39.17)
    const signal = this._streamRegistry.register(assistantMessageId);

    // 6. Execute streaming lifecycle with finally cleanup (§39.18, §39.25)
    const completion = this._runStream({
      conversationId,
      assistantMessageId,
      chatRequest,
      signal,
      adapter,
      startSequence: nextSequence,
    });

    return {
      conversationId,
      userMessageId,
      assistantMessageId,
      completion,
    };
  }

  private async _runStream(options: {
    conversationId: ConversationId;
    assistantMessageId: MessageId;
    chatRequest: ChatRequest;
    signal: AbortSignal;
    adapter: ProviderAdapter;
    startSequence: number;
  }): Promise<void> {
    const { conversationId, assistantMessageId, chatRequest, signal, adapter } = options;
    let sequence = options.startSequence;
    let terminalEmitted = false;

    try {
      const stream = adapter.chat(chatRequest, signal);

      for await (const chunk of stream) {
        if (signal.aborted && chunk.type !== "message.cancelled") {
          break;
        }

        const sequencedEvent: AIEvent = {
          ...chunk,
          conversationId,
          sequence: sequence++,
          schemaVersion: 1,
          timestamp: chunk.timestamp ?? now(),
          ...("messageId" in chunk ? { messageId: assistantMessageId } : {}),
        } as AIEvent;

        if (isTerminalEvent(sequencedEvent)) {
          terminalEmitted = true;
        }

        // Persist to storage and publish to EventBus (§39.19, §39.20)
        await this._storage.append(sequencedEvent);
        await this._eventBus.publish(sequencedEvent);

        if (terminalEmitted) {
          break;
        }
      }
    } catch (err: unknown) {
      const isCancelled =
        signal.aborted ||
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof BaseError && err.code === "CANCELLED");

      if (!terminalEmitted) {
        terminalEmitted = true;
        if (isCancelled) {
          // Cancellation: partial transcript preserved (§39.23, §39.24)
          const cancelEvent: MessageCancelledEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.cancelled",
            category: "core",
            messageId: assistantMessageId,
            reason: "Request cancelled by user",
          };
          try {
            await this._storage.append(cancelEvent);
          } catch {
            // If storage is faulted, still notify EventBus/renderer
          }
          await this._eventBus.publish(cancelEvent);
        } else {
          // Ordinary failure or storage failure: distinct from cancellation (§39.24, §40.15)
          const failEvent: MessageFailedEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.failed",
            category: "core",
            messageId: assistantMessageId,
            error: err instanceof Error ? err.message : String(err),
          };
          try {
            await this._storage.append(failEvent);
          } catch {
            // If storage is faulted, still notify EventBus/renderer
          }
          await this._eventBus.publish(failEvent);
        }
      }
    } finally {
      // If stream ended without emitting a terminal event, synthesize one (§39.22, §39.66)
      if (!terminalEmitted) {
        terminalEmitted = true;
        if (signal.aborted) {
          const cancelEvent: MessageCancelledEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.cancelled",
            category: "core",
            messageId: assistantMessageId,
            reason: "Request cancelled by user",
          };
          try {
            await this._storage.append(cancelEvent);
          } catch {
            // If storage is faulted, still notify EventBus/renderer
          }
          await this._eventBus.publish(cancelEvent);
        } else {
          const completeEvent: MessageCompletedEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.completed",
            category: "core",
            messageId: assistantMessageId,
            finishReason: "end_turn",
          };
          try {
            await this._storage.append(completeEvent);
          } catch {
            // If storage is faulted, still notify EventBus/renderer
          }
          await this._eventBus.publish(completeEvent);
        }
      }

      // Cleanup stream registry in finally (§39.25)
      this._streamRegistry.remove(assistantMessageId);
    }
  }
}
