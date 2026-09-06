// PR5: packages/ai-core — Conversation Projection Layer
//
// Pure, deterministic projection reducing the authoritative event stream into
// a canonical Conversation read model.
//
// Invariants:
//   - Pure function with no I/O, no persistence, no side effects.
//   - Derived entirely from the event stream.
//   - Messages within the conversation are derived via projectMessages.
//   - Respects event sequence ordering.

import type { ConversationId, Timestamp } from "@ai-desktop/shared";
import type { AIEvent } from "../events.js";
import type { Message } from "../message.js";
import { prepareEventStream } from "./helpers.js";
import { projectMessages } from "./messages.js";
import { EventStreamError } from "../errors.js";

export type ConversationStatus = "active" | "completed" | "archived";

export interface Conversation {
  readonly id: ConversationId;
  readonly title?: string;
  readonly status: ConversationStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly messages: readonly Message[];
  readonly lastSequence: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Projects an authoritative event history into a canonical Conversation read model.
 *
 * @param events All events for the conversation (or workspace).
 * @param targetConversationId Optional ID of the specific conversation to project.
 *                             If omitted, the conversationId of the first event is used.
 */
export function projectConversation(
  events: readonly AIEvent[],
  targetConversationId?: ConversationId,
): Conversation {
  const sortedEvents = prepareEventStream(events);

  if (sortedEvents.length === 0) {
    if (!targetConversationId) {
      throw new EventStreamError(
        "Cannot project conversation from empty event stream without a target conversationId",
      );
    }
    const emptyTs = "1970-01-01T00:00:00.000Z" as Timestamp;
    return {
      id: targetConversationId,
      status: "active",
      createdAt: emptyTs,
      updatedAt: emptyTs,
      messages: [],
      lastSequence: -1,
    };
  }

  const convId = targetConversationId ?? sortedEvents[0].conversationId;
  const conversationEvents = sortedEvents.filter((e) => e.conversationId === convId);

  if (conversationEvents.length === 0) {
    throw new EventStreamError(`No events found for target conversationId: "${convId}"`);
  }

  let title: string | undefined;
  const status: ConversationStatus = "active";
  let createdAt = conversationEvents[0].timestamp as Timestamp;
  let updatedAt = conversationEvents[0].timestamp as Timestamp;
  let lastSequence = conversationEvents[0].sequence;
  let metadata: Record<string, unknown> | undefined;

  for (const event of conversationEvents) {
    updatedAt = event.timestamp as Timestamp;
    lastSequence = Math.max(lastSequence, event.sequence);

    if (event.type === "conversation.created") {
      createdAt = event.timestamp as Timestamp;
      if (event.title) {
        title = event.title;
      }
      if (event.metadata) {
        metadata = { ...metadata, ...event.metadata };
      }
    }
  }

  const messages = projectMessages(conversationEvents);

  return {
    id: convId,
    title,
    status,
    createdAt,
    updatedAt,
    messages: Object.freeze(messages),
    lastSequence,
    metadata: metadata ? Object.freeze(metadata) : undefined,
  };
}
