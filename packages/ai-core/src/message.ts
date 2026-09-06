// PR4: packages/ai-core — Canonical Message Projection Model
//
// Architectural Principle:
//   Events are authoritative; Messages are materialized projections.
//   The Message model represents the projected state of a conversation turn,
//   suitable for rendering and provider context assembly, NOT the raw event log.

import { z } from "zod";
import type { ConversationId, MessageId, Timestamp } from "@ai-desktop/shared";
import { ConversationIdSchema, MessageIdSchema, TimestampStringSchema } from "@ai-desktop/shared";
import { type ContentPart, ContentPartSchema, isTextPart } from "./content.js";

export const MessageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageStatusSchema = z.enum(["streaming", "completed", "failed"]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const MessageSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  role: MessageRoleSchema,
  content: z.array(ContentPartSchema),
  status: MessageStatusSchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Message = {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  readonly status: MessageStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Extracts and concatenates all plain text parts within a message.
 */
export function getMessageText(message: { content: readonly ContentPart[] }): string {
  return message.content
    .filter(isTextPart)
    .map((p) => p.text)
    .join("\n");
}
