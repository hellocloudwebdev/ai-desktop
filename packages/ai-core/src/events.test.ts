import { describe, expect, it } from "vitest";
import {
  AIEventSchema,
  isCapabilityEvent,
  isCoreEvent,
  isExtensionEvent,
  type AIEvent,
  type ConversationCreatedEvent,
  type MessageCreatedEvent,
  type MessageDeltaEvent,
  type PermissionRequestedEvent,
  type TaskCreatedEvent,
  type ToolCallRequestedEvent,
} from "./events.js";
import {
  createConversationId,
  createMessageId,
  createPermissionRequestId,
  createTaskId,
  createToolCallId,
  now,
} from "@ai-desktop/shared";
import { createEventId, createTaskNodeId } from "./identifiers.js";
import { textPart } from "./content.js";

describe("ai-core events: AIEvent Discriminated Union and Validation", () => {
  it("validates core events (conversation.created, message.created, message.delta)", () => {
    const convId = createConversationId();

    const convCreated: ConversationCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
      title: "First Conversation",
    };
    expect(AIEventSchema.safeParse(convCreated).success).toBe(true);
    expect(isCoreEvent(convCreated)).toBe(true);
    expect(isCapabilityEvent(convCreated)).toBe(false);

    const msgCreated: MessageCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.created",
      category: "core",
      messageId: createMessageId(),
      role: "user",
      content: [textPart("Hello assistant")],
    };
    expect(AIEventSchema.safeParse(msgCreated).success).toBe(true);

    const delta: MessageDeltaEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 2,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "chunk",
    };
    expect(AIEventSchema.safeParse(delta).success).toBe(true);
  });

  it("validates capability events (tool.call.requested, permission.requested)", () => {
    const convId = createConversationId();
    const toolCallId = createToolCallId();

    const toolRequested: ToolCallRequestedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 3,
      schemaVersion: 1,
      timestamp: now(),
      type: "tool.call.requested",
      category: "capability",
      toolCallId,
      toolName: "bash",
      toolSource: "builtin",
      toolRuntime: "execution",
      input: { command: "ls" },
    };
    expect(AIEventSchema.safeParse(toolRequested).success).toBe(true);
    expect(isCapabilityEvent(toolRequested)).toBe(true);
    expect(isCoreEvent(toolRequested)).toBe(false);

    const permRequested: PermissionRequestedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 4,
      schemaVersion: 1,
      timestamp: now(),
      type: "permission.requested",
      category: "capability",
      permissionRequestId: createPermissionRequestId(),
      relatedToolCallIds: [toolCallId],
      capability: "shell:exec",
      action: "execute",
      resource: "/bin/bash",
      risk: "high",
      scope: "session",
    };
    expect(AIEventSchema.safeParse(permRequested).success).toBe(true);
  });

  it("validates extension events (task.created)", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const rootNodeId = createTaskNodeId();

    const taskCreated: TaskCreatedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 5,
      schemaVersion: 1,
      timestamp: now(),
      type: "task.created",
      category: "extension",
      taskId,
      title: "Analyze codebase",
      rootNodeIds: [rootNodeId],
    };
    expect(AIEventSchema.safeParse(taskCreated).success).toBe(true);
    expect(isExtensionEvent(taskCreated)).toBe(true);
  });

  it("enforces sequence and schemaVersion on all events", () => {
    const missingSeq = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      // missing sequence
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
    };
    expect(AIEventSchema.safeParse(missingSeq).success).toBe(false);

    const negativeSeq = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: -1,
      schemaVersion: 1,
      timestamp: now(),
      type: "conversation.created",
      category: "core",
    };
    expect(AIEventSchema.safeParse(negativeSeq).success).toBe(false);
  });

  it("allows exhaustive narrowing by type discriminator in TypeScript", () => {
    const event: AIEvent = {
      eventId: createEventId(),
      conversationId: createConversationId(),
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: createMessageId(),
      deltaText: "sample delta",
    };

    let handled = false;
    switch (event.type) {
      case "message.delta":
        expect(event.deltaText).toBe("sample delta");
        handled = true;
        break;
      default:
        break;
    }
    expect(handled).toBe(true);
  });
});
