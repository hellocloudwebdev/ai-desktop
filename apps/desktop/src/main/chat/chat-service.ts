// PR23: apps/desktop — Provider-Neutral Main Chat Service
//
// Invariants (Step 39 & PR23):
//   1. Provider-neutral execution: zero knowledge of Anthropic SDK, Gemini SDK,
//      or vendor-specific request/response types.
//   2. Consumes ModelSelectionService as the single authoritative resolution path.
//   3. Forms an explicit ChatExecutionContext (conversationId, modelSelection, model, adapter, request).
//   4. Validates request capabilities against model definition before execution (call count = 0 on violation).
//   5. Emits canonical user message event to storage and EventBus before streaming.
//   6. Registers stream in ActiveStreamRegistry BEFORE calling provider adapter.
//   7. Passes standard AbortSignal down to ProviderAdapter for cooperative cancellation.
//   8. Publishes canonical events through EventBus; EventBus routes to storage and IPC Batcher.
//   9. Persists every canonical event to EventRepository in monotonic sequence order.
//  10. Exactly one terminal lifecycle event per stream (no duplicate terminal events).
//  11. Stream cleanup (registry.remove) runs in a finally block.
//  12. Distinguishes cancellation from provider errors; preserves partial transcripts upon cancellation.
//  13. Idempotent cancellation: safe to call repeatedly or on completed/unknown streams.

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
  type ChatRequestOptions,
  type Conversation,
  type Message,
  type MessageCreatedEvent,
  type MessageFailedEvent,
  type MessageCancelledEvent,
  type MessageCompletedEvent,
  type ModelDefinition,
  type ToolDefinition,
} from "@ai-desktop/ai-core";
import {
  UnsupportedCapabilityError,
  type ModelSelection,
  type ProviderAdapter,
} from "@ai-desktop/providers";
import type { EventBus } from "@ai-desktop/agent-runtime";
import type { EventRepository } from "@ai-desktop/storage";
import { isTerminalEvent } from "../ipc/batcher.js";
import type { ActiveStreamRegistry } from "./active-stream-registry.js";
import type { ModelSelectionService } from "./model-selection-service.js";

/**
 * Provider-neutral chat execution context (§PR23.2).
 * Bundles the resolved routing decisions and canonical request.
 */
export interface ChatExecutionContext {
  readonly conversationId: ConversationId;
  readonly modelSelection: ModelSelection;
  readonly model: ModelDefinition;
  readonly adapter: ProviderAdapter;
  readonly request: ChatRequest;
}

export interface SendMessageInput {
  conversationId?: string;
  content: string;
  clientMessageId?: string;
  modelId?: string;
  profileId?: string;
  systemPrompt?: string;
  tools?: readonly ToolDefinition[];
  options?: ChatRequestOptions;
}

export interface SendMessageResult {
  conversationId: ConversationId;
  userMessageId: MessageId;
  assistantMessageId: MessageId;
  completion: Promise<void>;
}

export interface ChatServiceDependencies {
  readonly modelSelectionService: ModelSelectionService;
  readonly streamRegistry: ActiveStreamRegistry;
  readonly eventBus: EventBus;
  readonly storage: EventRepository;
}

/**
 * Validates request capabilities against model definition before execution (§PR23.10).
 * Throws UnsupportedCapabilityError if a requested capability is not supported by the model.
 */
export function validateRequestCapabilities(request: ChatRequest, model: ModelDefinition): void {
  // 1. Streaming capability (ChatService operates via streaming)
  if (!model.capabilities.includes("streaming")) {
    throw new UnsupportedCapabilityError(
      "streaming",
      `Model "${model.id}" does not support streaming`,
      { providerId: model.providerId, modelId: model.id },
    );
  }

  // 2. Thinking / extended reasoning capability
  if (request.options?.thinking?.enabled && !model.capabilities.includes("thinking")) {
    throw new UnsupportedCapabilityError(
      "thinking",
      `Model "${model.id}" does not support thinking / extended reasoning`,
      { providerId: model.providerId, modelId: model.id },
    );
  }

  // 3. Tool use capability
  if (request.tools && request.tools.length > 0 && !model.capabilities.includes("tool_use")) {
    throw new UnsupportedCapabilityError(
      "tool_use",
      `Model "${model.id}" does not support tool use`,
      { providerId: model.providerId, modelId: model.id },
    );
  }

  // 4. Vision capability
  for (const msg of request.messages) {
    if (msg.content.some((part) => part.type === "image")) {
      if (!model.capabilities.includes("vision")) {
        throw new UnsupportedCapabilityError(
          "vision",
          `Model "${model.id}" does not support vision / image input`,
          { providerId: model.providerId, modelId: model.id },
        );
      }
    }
  }
}

export class ChatService {
  private readonly _modelSelectionService: ModelSelectionService;
  private readonly _streamRegistry: ActiveStreamRegistry;
  private readonly _eventBus: EventBus;
  private readonly _storage: EventRepository;

  constructor(deps: ChatServiceDependencies) {
    this._modelSelectionService = deps.modelSelectionService;
    this._streamRegistry = deps.streamRegistry;
    this._eventBus = deps.eventBus;
    this._storage = deps.storage;
  }

  get modelSelectionService(): ModelSelectionService {
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
   * Idempotent: safe to call multiple times or on unknown/completed messages (§PR23.8).
   * Returns true if an active stream was found and aborted, false otherwise.
   */
  cancel(messageId: MessageId): boolean {
    return this._streamRegistry.abort(messageId, "User requested cancellation");
  }

  /**
   * Sends a user message, publishes canonical events, and streams assistant generation
   * via the resolved provider adapter (§PR23.2-PR23.7).
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const conversationId: ConversationId = (input.conversationId ??
      createConversationId()) as ConversationId;
    const userMessageId: MessageId = createMessageId();
    const assistantMessageId: MessageId = (input.clientMessageId ?? createMessageId()) as MessageId;

    // 1. Centralized provider & model resolution via ModelSelectionService (PR23.2, PR23.4)
    const route = await this._modelSelectionService.resolveForConversation(
      conversationId,
      input.modelId,
      input.profileId,
    );

    // 2. Load historical events to maintain monotonic sequence ordering (§39.21)
    const historicalEvents = await this._storage.getByConversation(conversationId);
    let nextSequence =
      historicalEvents.length > 0 ? Math.max(...historicalEvents.map((e) => e.sequence)) + 1 : 0;

    // 3. Project conversation state to construct canonical ChatRequest (§39.15, §39.16)
    const userContent = [textPart(input.content)];
    const userMessageInput: ChatMessageInput = {
      id: userMessageId,
      role: "user",
      content: userContent,
    };

    const projectedConv = projectConversation(historicalEvents, conversationId);
    const messages: ChatMessageInput[] = [
      ...projectedConv.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      })),
      userMessageInput,
    ];

    const chatRequest: ChatRequest = {
      conversationId,
      modelId: route.model.id,
      messages,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      options: input.options,
    };

    // 4. Form provider-neutral execution context (PR23.2)
    const context: ChatExecutionContext = {
      conversationId,
      modelSelection: route.selection,
      model: route.model,
      adapter: route.adapter,
      request: chatRequest,
    };

    // 5. Capability validation before provider execution — rejects before network call (§PR23.10)
    validateRequestCapabilities(context.request, context.model);

    // 6. Emit and persist canonical user message event (§39.14, PR23.6, PR23.7)
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
      content: userContent,
    };

    await this._storage.append(userEvent);
    await this._eventBus.publish(userEvent);

    // 7. Register in ActiveStreamRegistry BEFORE calling provider adapter (§39.17, PR23.5)
    const signal = this._streamRegistry.register(assistantMessageId);

    // 8. Execute streaming lifecycle with finally cleanup (§39.18, §39.25, PR23.5-PR23.9)
    const completion = this._runStream({
      context,
      assistantMessageId,
      signal,
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
    context: ChatExecutionContext;
    assistantMessageId: MessageId;
    signal: AbortSignal;
    startSequence: number;
  }): Promise<void> {
    const { context, assistantMessageId, signal, startSequence } = options;
    const { conversationId, adapter, request } = context;
    let sequence = startSequence;
    let terminalEmitted = false;

    try {
      const stream = adapter.chat(request, signal);

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
          // Cancellation: partial transcript preserved (§39.23, §39.24, PR23.8)
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
          // Canonical failure: distinct from cancellation (§39.24, §40.15, PR23.9)
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
      // If stream ended without emitting a terminal event, synthesize exactly one (§39.22, §39.66, PR23.12)
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

      // Cleanup stream registry in finally (§39.25, PR23.5)
      this._streamRegistry.remove(assistantMessageId);
    }
  }
}
