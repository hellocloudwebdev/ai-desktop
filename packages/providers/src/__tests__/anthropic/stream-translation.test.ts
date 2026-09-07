import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createConversationId, createMessageId } from "@ai-desktop/shared";
import {
  type MessageCompletedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type ToolCallRequestedEvent,
} from "@ai-desktop/ai-core";
import { translateAnthropicStream } from "../../anthropic/translate-stream.js";

describe("Anthropic: Stream Translation Boundary", () => {
  it("translates raw Anthropic stream chunks into canonical AIEvent sequence", async () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    async function* makeFakeAnthropicStream(): AsyncIterable<Anthropic.MessageStreamEvent> {
      yield {
        type: "message_start",
        message: {
          id: "msg_123",
          role: "assistant",
          usage: { input_tokens: 15, output_tokens: 0 },
        },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "world!" },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_stop",
        index: 0,
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 8 },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "message_stop",
      } as unknown as Anthropic.MessageStreamEvent;
    }

    const events = [];
    for await (const event of translateAnthropicStream(makeFakeAnthropicStream(), {
      conversationId: convId,
      messageId: msgId,
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(4);

    const started = events[0] as MessageStartedEvent;
    expect(started.type).toBe("message.started");
    expect(started.messageId).toBe(msgId);
    expect(started.conversationId).toBe(convId);

    const deltas = events.filter((e) => e.type === "message.delta") as MessageDeltaEvent[];
    expect(deltas).toHaveLength(2);
    expect(deltas[0].deltaText).toBe("Hello ");
    expect(deltas[1].deltaText).toBe("world!");

    const completed = events[events.length - 1] as MessageCompletedEvent;
    expect(completed.type).toBe("message.completed");
    expect(completed.finishReason).toBe("end_turn");
    expect(completed.totalTokens).toBe(23); // 15 input + 8 output
  });

  it("translates streaming tool call chunks into canonical tool.call.requested event", async () => {
    const convId = createConversationId();
    const msgId = createMessageId();

    async function* makeToolCallStream(): AsyncIterable<Anthropic.MessageStreamEvent> {
      yield {
        type: "message_start",
        message: { id: "msg_tool", role: "assistant" },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_01M1VJNQTKK6BWB7STBDKGZGG1",
          name: "read_file",
        },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"path": ',
        },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '"package.json"}',
        },
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "content_block_stop",
        index: 0,
      } as unknown as Anthropic.MessageStreamEvent;
      yield {
        type: "message_stop",
      } as unknown as Anthropic.MessageStreamEvent;
    }

    const events = [];
    for await (const event of translateAnthropicStream(makeToolCallStream(), {
      conversationId: convId,
      messageId: msgId,
    })) {
      events.push(event);
    }

    const toolEvents = events.filter(
      (e) => e.type === "tool.call.requested",
    ) as ToolCallRequestedEvent[];
    expect(toolEvents).toHaveLength(1);

    const toolEvent = toolEvents[0];
    expect(toolEvent.toolName).toBe("read_file");
    expect(toolEvent.toolCallId).toBe("toolu_01M1VJNQTKK6BWB7STBDKGZGG1");
    expect(toolEvent.input).toEqual({ path: "package.json" });
  });
});
