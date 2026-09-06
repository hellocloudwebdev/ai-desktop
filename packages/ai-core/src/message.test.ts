import { describe, expect, it } from "vitest";
import { getMessageText, MessageSchema, type Message } from "./message.js";
import { createConversationId, createMessageId, now } from "@ai-desktop/shared";
import { textPart, toolCallPart } from "./content.js";
import { createToolCallId } from "@ai-desktop/shared";

describe("ai-core message: Materialized Message Projection", () => {
  it("validates a fully formed Message model via schema", () => {
    const msg: Message = {
      id: createMessageId(),
      conversationId: createConversationId(),
      role: "assistant",
      content: [
        textPart("Here is the answer"),
        toolCallPart(createToolCallId(), "search", { q: "term" }),
      ],
      status: "completed",
      createdAt: now(),
      updatedAt: now(),
      metadata: { model: "claude-3-5-sonnet", tokens: 150 },
    };

    const parsed = MessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it("extracts plain text content from a message via getMessageText", () => {
    const msg = {
      content: [
        textPart("First line"),
        toolCallPart(createToolCallId(), "test", {}),
        textPart("Second line"),
      ],
    };

    const text = getMessageText(msg);
    expect(text).toBe("First line\nSecond line");
  });

  it("rejects messages with invalid roles or statuses", () => {
    const invalidRole = {
      id: createMessageId(),
      conversationId: createConversationId(),
      role: "super_admin",
      content: [textPart("text")],
      status: "completed",
      createdAt: now(),
      updatedAt: now(),
    };
    expect(MessageSchema.safeParse(invalidRole).success).toBe(false);

    const invalidStatus = {
      id: createMessageId(),
      conversationId: createConversationId(),
      role: "user",
      content: [textPart("text")],
      status: "pending", // valid are: streaming, completed, failed
      createdAt: now(),
      updatedAt: now(),
    };
    expect(MessageSchema.safeParse(invalidStatus).success).toBe(false);
  });
});
