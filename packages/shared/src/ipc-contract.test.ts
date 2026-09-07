import { describe, expect, it } from "vitest";
import {
  ChatCancelCommandSchema,
  ChatSendCommandSchema,
  ChatStreamEventSchema,
  IPC_CHANNELS,
  validateChatCancelCommand,
  validateChatSendCommand,
  validateChatStreamEvent,
} from "./ipc-contract.js";
import { createConversationId, createMessageId, createTaskId, createToolCallId } from "./ids.js";
import { now } from "./time.js";

describe("ipc-contract: Channel Definitions", () => {
  it("defines standard, predictable channel name strings", () => {
    expect(IPC_CHANNELS.CHAT_SEND).toBe("chat:send");
    expect(IPC_CHANNELS.CHAT_CANCEL).toBe("chat:cancel");
    expect(IPC_CHANNELS.CHAT_STREAM_EVENT).toBe("chat:stream-event");
    expect(IPC_CHANNELS.CHAT_SUBSCRIBE).toBe("chat:subscribe");
    expect(IPC_CHANNELS.CHAT_UNSUBSCRIBE).toBe("chat:unsubscribe");
  });
});

describe("ipc-contract: ChatSendCommand Validation", () => {
  it("validates a well-formed ChatSendCommand", () => {
    const convId = createConversationId();
    const msgId = createMessageId();
    const input = {
      conversationId: convId,
      content: "Hello assistant, write a test",
      clientMessageId: msgId,
      metadata: { source: "ui" },
      timestamp: now(),
    };

    const parsed = ChatSendCommandSchema.safeParse(input);
    expect(parsed.success).toBe(true);

    const validated = validateChatSendCommand(input);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.conversationId).toBe(convId);
      expect(validated.value.content).toBe("Hello assistant, write a test");
    }
  });

  it("rejects empty or missing content in ChatSendCommand", () => {
    const convId = createConversationId();

    const emptyContent = { conversationId: convId, content: "" };
    expect(ChatSendCommandSchema.safeParse(emptyContent).success).toBe(false);

    const missingContent = { conversationId: convId };
    expect(ChatSendCommandSchema.safeParse(missingContent).success).toBe(false);

    const validationResult = validateChatSendCommand(emptyContent);
    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.error.message).toContain("content");
    }
  });

  it("rejects invalid ULID for conversationId", () => {
    const badId = { conversationId: "not-a-ulid", content: "Hello" };
    const res = validateChatSendCommand(badId);
    expect(res.ok).toBe(false);
  });
});

describe("ipc-contract: ChatCancelCommand Validation", () => {
  it("validates a well-formed ChatCancelCommand", () => {
    const convId = createConversationId();
    const taskId = createTaskId();
    const msgId = createMessageId();
    const input = {
      conversationId: convId,
      messageId: msgId,
      taskId,
      reason: "User cancelled generation",
    };

    const schemaParsed = ChatCancelCommandSchema.safeParse(input);
    expect(schemaParsed.success).toBe(true);

    const validated = validateChatCancelCommand(input);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.conversationId).toBe(convId);
      expect(validated.value.messageId).toBe(msgId);
      expect(validated.value.taskId).toBe(taskId);
      expect(validated.value.reason).toBe("User cancelled generation");
    }
  });

  it("rejects invalid conversationId or excessive reason length", () => {
    const badId = { conversationId: "bad-id" };
    expect(validateChatCancelCommand(badId).ok).toBe(false);

    const excessiveReason = {
      conversationId: createConversationId(),
      reason: "x".repeat(600), // max is 500
    };
    expect(validateChatCancelCommand(excessiveReason).ok).toBe(false);
  });
});

describe("ipc-contract: ChatStreamEvent Validation", () => {
  it("validates delta stream events", () => {
    const event = {
      conversationId: createConversationId(),
      sequence: 0,
      timestamp: now(),
      kind: "delta",
      payload: {
        kind: "delta",
        delta: {
          text: "Here is the response chunk",
        },
      },
    };

    const validated = validateChatStreamEvent(event);
    expect(validated.ok).toBe(true);
  });

  it("validates tool_call stream events", () => {
    const event = {
      conversationId: createConversationId(),
      sequence: 1,
      timestamp: now(),
      kind: "tool_call",
      payload: {
        kind: "tool_call",
        toolCall: {
          toolCallId: createToolCallId(),
          toolName: "read_file",
          arguments: { path: "src/index.ts" },
        },
      },
    };

    const validated = validateChatStreamEvent(event);
    expect(validated.ok).toBe(true);
  });

  it("validates tool_result stream events", () => {
    const event = {
      conversationId: createConversationId(),
      sequence: 2,
      timestamp: now(),
      kind: "tool_result",
      payload: {
        kind: "tool_result",
        toolResult: {
          toolCallId: createToolCallId(),
          result: { success: true },
          isError: false,
        },
      },
    };

    const validated = validateChatStreamEvent(event);
    expect(validated.ok).toBe(true);
  });

  it("validates done stream events", () => {
    const event = {
      conversationId: createConversationId(),
      sequence: 3,
      timestamp: now(),
      kind: "done",
      payload: {
        kind: "done",
        done: {
          finishReason: "stop",
        },
      },
    };

    const validated = validateChatStreamEvent(event);
    expect(validated.ok).toBe(true);
  });

  it("rejects negative sequence numbers", () => {
    const event = {
      conversationId: createConversationId(),
      sequence: -1,
      timestamp: now(),
      kind: "delta",
      payload: {
        kind: "delta",
        delta: { text: "chunk" },
      },
    };

    expect(ChatStreamEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects unknown event kinds", () => {
    const event = {
      conversationId: createConversationId(),
      sequence: 0,
      timestamp: now(),
      kind: "unknown_future_kind",
      payload: {},
    };

    expect(ChatStreamEventSchema.safeParse(event).success).toBe(false);
  });
});
