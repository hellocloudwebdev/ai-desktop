// PR5: packages/ai-core — Message Projection Layer
//
// Pure, deterministic projection reducing the authoritative event stream into
// a materialized read model of Message[] objects.
//
// Invariants:
//   - Pure function with no I/O, no persistence, no provider/Electron coupling.
//   - Input events and previous projection states are never mutated.
//   - Consecutive message deltas are merged into coherent text content parts.
//   - Cancellation preserves all already-accumulated streamed tokens/content.
//   - Respects event sequence ordering.

import type { MessageId, Timestamp } from "@ai-desktop/shared";
import type { AIEvent } from "../events.js";
import type { ContentPart, TextContent } from "../content.js";
import type { Message, MessageRole, MessageStatus } from "../message.js";
import { prepareEventStream } from "./helpers.js";
import { EventStreamError } from "../errors.js";

interface MutableMessageState {
  id: MessageId;
  conversationId: Message["conversationId"];
  role: MessageRole;
  content: ContentPart[];
  status: MessageStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  metadata?: Record<string, unknown>;
}

function cloneContentParts(parts: readonly ContentPart[]): ContentPart[] {
  return parts.map((part) => ({ ...part }));
}

function toReadonlyMessage(state: MutableMessageState): Message {
  return {
    id: state.id,
    conversationId: state.conversationId,
    role: state.role,
    content: Object.freeze(cloneContentParts(state.content)),
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    metadata: state.metadata ? Object.freeze({ ...state.metadata }) : undefined,
  };
}

/**
 * Pure incremental reducer that applies a single AIEvent to an existing Map of messages.
 * Used by both bulk projection (replay) and streaming reduction.
 */
export function applyEventToMessages(
  messageMap: Map<MessageId, MutableMessageState>,
  event: AIEvent,
): void {
  const ts = event.timestamp as Timestamp;

  switch (event.type) {
    case "message.started": {
      if (!event.messageId) {
        throw new EventStreamError(`Invalid message.started event: missing messageId`);
      }
      const existing = messageMap.get(event.messageId);
      if (existing) {
        existing.status = "streaming";
        existing.updatedAt = ts;
      } else {
        messageMap.set(event.messageId, {
          id: event.messageId,
          conversationId: event.conversationId,
          role: event.role,
          content: cloneContentParts(event.content ?? []),
          status: "streaming",
          createdAt: ts,
          updatedAt: ts,
        });
      }
      break;
    }

    case "message.created": {
      if (!event.messageId) {
        throw new EventStreamError(`Invalid message.created event: missing messageId`);
      }
      const existing = messageMap.get(event.messageId);
      if (existing) {
        existing.role = event.role;
        existing.content = cloneContentParts(event.content);
        existing.status = "completed";
        existing.updatedAt = ts;
      } else {
        messageMap.set(event.messageId, {
          id: event.messageId,
          conversationId: event.conversationId,
          role: event.role,
          content: cloneContentParts(event.content),
          status: "completed",
          createdAt: ts,
          updatedAt: ts,
        });
      }
      break;
    }

    case "message.delta": {
      if (!event.messageId) {
        throw new EventStreamError(`Invalid message.delta event: missing messageId`);
      }
      let targetMessage = messageMap.get(event.messageId);
      if (!targetMessage) {
        targetMessage = {
          id: event.messageId,
          conversationId: event.conversationId,
          role: "assistant",
          content: [],
          status: "streaming",
          createdAt: ts,
          updatedAt: ts,
        };
        messageMap.set(event.messageId, targetMessage);
      }

      // Merge incremental delta into the last text part, or create a new text part
      const deltaText = event.deltaText ?? "";
      if (deltaText.length > 0) {
        const lastPartIndex = targetMessage.content.length - 1;
        const lastPart = lastPartIndex >= 0 ? targetMessage.content[lastPartIndex] : undefined;

        if (lastPart && lastPart.type === "text") {
          // In-place merge inside reducer state: concatenates token chunks into coherent text
          (lastPart as TextContent).text += deltaText;
        } else {
          targetMessage.content.push({ type: "text", text: deltaText });
        }
      }

      targetMessage.updatedAt = ts;
      break;
    }

    case "message.completed": {
      if (!event.messageId) {
        throw new EventStreamError(`Invalid message.completed event: missing messageId`);
      }
      const message = messageMap.get(event.messageId);
      if (message) {
        message.status = "completed";
        message.updatedAt = ts;
        if (event.finishReason || event.totalTokens !== undefined) {
          message.metadata = {
            ...message.metadata,
            ...(event.finishReason ? { finishReason: event.finishReason } : {}),
            ...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
          };
        }
      }
      break;
    }

    case "message.failed": {
      if (!event.messageId) {
        throw new EventStreamError(`Invalid message.failed event: missing messageId`);
      }
      const message = messageMap.get(event.messageId);
      if (message) {
        message.status = "failed";
        message.updatedAt = ts;
        message.metadata = {
          ...message.metadata,
          error: event.error,
          ...(event.code ? { code: event.code } : {}),
        };
      }
      break;
    }

    case "message.cancelled": {
      if (!event.messageId) {
        throw new EventStreamError(`Invalid message.cancelled event: missing messageId`);
      }
      const message = messageMap.get(event.messageId);
      if (message) {
        // Critical requirement: Cancellation preserves already-accumulated content
        message.status = "cancelled";
        message.updatedAt = ts;
        if (event.reason) {
          message.metadata = {
            ...message.metadata,
            cancellationReason: event.reason,
          };
        }
      }
      break;
    }

    default:
      // Other events (tasks, permissions, tool calls) are safely ignored by message projection
      break;
  }
}

/**
 * Projects an authoritative event history into an ordered list of Message models.
 *
 * Requirements met:
 *   - Pure, deterministic replay.
 *   - Consecutive deltas merged into coherent text content parts.
 *   - Cancellation preserves partial transcripts.
 *   - No input mutation.
 */
export function projectMessages(events: readonly AIEvent[]): Message[] {
  const sortedEvents = prepareEventStream(events);
  const messageMap = new Map<MessageId, MutableMessageState>();

  for (const event of sortedEvents) {
    applyEventToMessages(messageMap, event);
  }

  // Preserve insertion order (which mirrors the creation sequence)
  return Array.from(messageMap.values()).map(toReadonlyMessage);
}
