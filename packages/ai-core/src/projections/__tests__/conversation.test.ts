import { describe, expect, it } from "vitest";
import { projectConversation } from "../conversation.js";
import { asTimestamp, createConversationId, createMessageId, now } from "@ai-desktop/shared";
import { createEventId } from "../../identifiers.js";
import { textPart } from "../../content.js";
import type {
  AIEvent,
  ConversationCreatedEvent,
  MessageCompletedEvent,
  MessageCreatedEvent,
  MessageDeltaEvent,
  MessageStartedEvent,
} from "../../events.js";
import { EventStreamError } from "../../errors.js";

describe("projections: Conversation Projection", () => {
  it("projects a complete conversation lifecycle including messages and metadata", () => {
    const convId = createConversationId();
    const userMsgId = createMessageId();
    const assistantMsgId = createMessageId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: asTimestamp("2026-09-06T10:00:00.000Z"),
        type: "conversation.created",
        category: "core",
        title: "Coding Session",
        metadata: { model: "claude-3-5-sonnet" },
      } as ConversationCreatedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 1,
        schemaVersion: 1,
        timestamp: asTimestamp("2026-09-06T10:00:01.000Z"),
        type: "message.created",
        category: "core",
        messageId: userMsgId,
        role: "user",
        content: [textPart("Please write a function")],
      } as MessageCreatedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 2,
        schemaVersion: 1,
        timestamp: asTimestamp("2026-09-06T10:00:02.000Z"),
        type: "message.started",
        category: "core",
        messageId: assistantMsgId,
        role: "assistant",
        content: [],
      } as MessageStartedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 3,
        schemaVersion: 1,
        timestamp: asTimestamp("2026-09-06T10:00:03.000Z"),
        type: "message.delta",
        category: "core",
        messageId: assistantMsgId,
        deltaText: "function test()",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 4,
        schemaVersion: 1,
        timestamp: asTimestamp("2026-09-06T10:00:04.000Z"),
        type: "message.delta",
        category: "core",
        messageId: assistantMsgId,
        deltaText: " { return true; }",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 5,
        schemaVersion: 1,
        timestamp: asTimestamp("2026-09-06T10:00:05.000Z"),
        type: "message.completed",
        category: "core",
        messageId: assistantMsgId,
        finishReason: "stop",
      } as MessageCompletedEvent,
    ];

    const conversation = projectConversation(events, convId);

    expect(conversation.id).toBe(convId);
    expect(conversation.title).toBe("Coding Session");
    expect(conversation.status).toBe("active");
    expect(conversation.createdAt).toBe("2026-09-06T10:00:00.000Z");
    expect(conversation.updatedAt).toBe("2026-09-06T10:00:05.000Z");
    expect(conversation.lastSequence).toBe(5);
    expect(conversation.metadata?.model).toBe("claude-3-5-sonnet");

    // Messages projection verification
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0].id).toBe(userMsgId);
    expect(conversation.messages[1].id).toBe(assistantMsgId);
    expect(conversation.messages[1].content[0]).toEqual({
      type: "text",
      text: "function test() { return true; }",
    });
  });

  it("produces deterministic conversation projections across multiple runs", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "conversation.created",
        category: "core",
        title: "Test Run",
      } as ConversationCreatedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 1,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.created",
        category: "core",
        messageId: msgId,
        role: "user",
        content: [textPart("Hello")],
      } as MessageCreatedEvent,
    ];

    const projA = projectConversation(events);
    const projB = projectConversation(events);

    expect(projA).toEqual(projB);
  });

  it("throws EventStreamError when given empty events without conversationId", () => {
    expect(() => projectConversation([])).toThrow(EventStreamError);
  });
});
