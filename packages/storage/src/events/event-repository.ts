// PR8: packages/storage — EventRepository Interface
//
// Architectural Scope:
//   Storage abstraction for append-only canonical event history.
//   Strictly NO update, delete, or replace APIs for historical events.
//   Reads return events in ascending sequence order.

import type { ConversationId } from "@ai-desktop/shared";
import type { AIEvent } from "@ai-desktop/ai-core";

export interface EventRepository {
  /**
   * Appends an immutable canonical AIEvent to the persistent event log.
   * Fails with a constraint error if (conversationId, sequence) already exists.
   *
   * @param event The canonical AIEvent to store.
   */
  append(event: Readonly<AIEvent>): Promise<void>;

  /**
   * Reads all historical events for a specific conversation in ascending sequence order.
   * Returns empty array [] if the conversation has no recorded events.
   *
   * @param conversationId The ID of the conversation whose events to retrieve.
   */
  getByConversation(conversationId: ConversationId): Promise<AIEvent[]>;
}
