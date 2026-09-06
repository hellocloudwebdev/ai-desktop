import { describe, expect, it } from "vitest";
import { projectMessages } from "../messages.js";
import { asTaskId, createConversationId, createMessageId, now } from "@ai-desktop/shared";
import { createEventId } from "../../identifiers.js";
import { textPart } from "../../content.js";
import type {
  AIEvent,
  MessageCancelledEvent,
  MessageCompletedEvent,
  MessageCreatedEvent,
  MessageDeltaEvent,
  MessageStartedEvent,
  TaskCreatedEvent,
} from "../../events.js";
import { EventStreamError } from "../../errors.js";

describe("projections: Message Replay & Delta Merging", () => {
  it("merges consecutive stream deltas into a single coherent text content part", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.started",
        category: "core",
        messageId: msgId,
        role: "assistant",
        content: [],
      } as MessageStartedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 1,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msgId,
        deltaText: "Hel",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 2,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msgId,
        deltaText: "lo",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 3,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msgId,
        deltaText: " world!",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 4,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.completed",
        category: "core",
        messageId: msgId,
        finishReason: "stop",
        totalTokens: 5,
      } as MessageCompletedEvent,
    ];

    const messages = projectMessages(events);

    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.id).toBe(msgId);
    expect(msg.role).toBe("assistant");
    expect(msg.status).toBe("completed");
    expect(msg.metadata?.finishReason).toBe("stop");
    expect(msg.metadata?.totalTokens).toBe(5);

    // Critical assertion: Token chunks MUST be merged into one text part
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({ type: "text", text: "Hello world!" });
  });

  it("applies deltas to the correct message without leaking across messages", () => {
    const convId = createConversationId();
    const msg1 = createMessageId();
    const msg2 = createMessageId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.started",
        category: "core",
        messageId: msg1,
        role: "assistant",
        content: [],
      } as MessageStartedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 1,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.started",
        category: "core",
        messageId: msg2,
        role: "assistant",
        content: [],
      } as MessageStartedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 2,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msg1,
        deltaText: "Msg1ChunkA",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 3,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msg2,
        deltaText: "Msg2ChunkA",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 4,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msg1,
        deltaText: "Msg1ChunkB",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 5,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.completed",
        category: "core",
        messageId: msg1,
      } as MessageCompletedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 6,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.completed",
        category: "core",
        messageId: msg2,
      } as MessageCompletedEvent,
    ];

    const messages = projectMessages(events);
    expect(messages).toHaveLength(2);

    const projected1 = messages.find((m) => m.id === msg1)!;
    const projected2 = messages.find((m) => m.id === msg2)!;

    expect(projected1.content[0]).toEqual({ type: "text", text: "Msg1ChunkAMsg1ChunkB" });
    expect(projected2.content[0]).toEqual({ type: "text", text: "Msg2ChunkA" });
  });

  it("preserves partial streamed content when cancellation occurs", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.started",
        category: "core",
        messageId: msgId,
        role: "assistant",
        content: [],
      } as MessageStartedEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 1,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msgId,
        deltaText: "I was in the middle of generating a response when",
      } as MessageDeltaEvent,
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 2,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.cancelled",
        category: "core",
        messageId: msgId,
        reason: "User pressed stop button",
      } as MessageCancelledEvent,
    ];

    const messages = projectMessages(events);
    expect(messages).toHaveLength(1);

    const msg = messages[0];
    expect(msg.status).toBe("cancelled");
    expect(msg.metadata?.cancellationReason).toBe("User pressed stop button");

    // Critical requirement: Partial content MUST NOT be lost
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toEqual({
      type: "text",
      text: "I was in the middle of generating a response when",
    });
  });
});

describe("projections: Message Ordering, Determinism, and Immutability", () => {
  it("reconstructs identical messages regardless of initial event array shuffle", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    const event0: AIEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: msgId,
      role: "assistant",
      content: [],
    } as MessageStartedEvent;

    const event1: AIEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: msgId,
      deltaText: "Deterministic",
    } as MessageDeltaEvent;

    const event2: AIEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 2,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: msgId,
    } as MessageCompletedEvent;

    const ordered = [event0, event1, event2];
    const shuffled = [event2, event0, event1];

    const proj1 = projectMessages(ordered);
    const proj2 = projectMessages(shuffled);

    expect(proj1).toEqual(proj2);
    expect(proj1[0].content[0]).toEqual({ type: "text", text: "Deterministic" });
  });

  it("does not mutate input events or payloads", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    const originalContent = [textPart("Initial text")];
    const event: AIEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: msgId,
      role: "user",
      content: originalContent,
    };

    const eventsCopy = [event];
    projectMessages(eventsCopy);

    expect(eventsCopy).toHaveLength(1);
    expect(eventsCopy[0]).toBe(event);
    expect(event.content).toEqual(originalContent);
  });

  it("safely ignores irrelevant events from other domains", () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "task.created",
        category: "extension",
        taskId: asTaskId("01M1VJNQTKK6BWB7STBDKGZGG1"),
        title: "Some task",
        rootNodeIds: [],
      } as TaskCreatedEvent,
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
      },
    ];

    const messages = projectMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msgId);
  });

  it("fails deterministically on unsupported schemaVersion", () => {
    const convId = createConversationId();
    const events: AIEvent[] = [
      {
        eventId: createEventId(),
        conversationId: convId,
        sequence: 0,
        schemaVersion: 999, // Unsupported future version
        timestamp: now(),
        type: "message.created",
        category: "core",
        messageId: createMessageId(),
        role: "user",
        content: [textPart("Hi")],
      } as unknown as MessageCreatedEvent,
    ];

    expect(() => projectMessages(events)).toThrow(EventStreamError);
  });
});
