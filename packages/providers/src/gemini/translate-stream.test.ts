import { describe, expect, it } from "vitest";
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import { createConversationId, createMessageId } from "@ai-desktop/shared";
import type {
  AIEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageStartedEvent,
  ThinkingCompletedEvent,
  ThinkingDeltaEvent,
  ToolCallRequestedEvent,
} from "@ai-desktop/ai-core";
import {
  translateGeminiFinishReason,
  translateGeminiStream,
  translateGeminiStreamChunk,
  type GeminiStreamContext,
  type GeminiStreamState,
} from "./translate-stream.js";

function makeContext(): GeminiStreamContext {
  return {
    conversationId: createConversationId(),
    messageId: createMessageId(),
    initialSequence: 0,
  };
}

function makeState(sequence = 0): GeminiStreamState {
  return {
    hasEmittedStarted: false,
    hasEmittedCompleted: false,
    activeThinking: false,
    sequence,
  };
}

describe("packages/providers: Gemini Stream Translation (PR21.4)", () => {
  it("Test 1: first text chunk emits message.started followed by message.delta (§Step 18)", () => {
    const context = makeContext();
    const state = makeState();

    const chunk: GenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello" }],
          },
        },
      ],
    } as unknown as GenerateContentResponse;

    const events = translateGeminiStreamChunk(chunk, context, state);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("message.started");
    expect((events[0] as MessageStartedEvent).role).toBe("assistant");
    expect((events[0] as MessageStartedEvent).messageId).toBe(context.messageId);

    expect(events[1].type).toBe("message.delta");
    expect((events[1] as MessageDeltaEvent).deltaText).toBe("Hello");
    expect(state.hasEmittedStarted).toBe(true);
  });

  it("Test 2 & Test 10: multiple text chunks emit message.started exactly ONCE (§Step 18)", () => {
    const context = makeContext();
    const state = makeState();

    const chunk1: GenerateContentResponse = {
      candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }],
    } as unknown as GenerateContentResponse;

    const chunk2: GenerateContentResponse = {
      candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }],
    } as unknown as GenerateContentResponse;

    const chunk3: GenerateContentResponse = {
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: { role: "model", parts: [] },
        },
      ],
    } as unknown as GenerateContentResponse;

    const events1 = translateGeminiStreamChunk(chunk1, context, state);
    const events2 = translateGeminiStreamChunk(chunk2, context, state);
    const events3 = translateGeminiStreamChunk(chunk3, context, state);

    const allEvents = [...events1, ...events2, ...events3];
    const startedEvents = allEvents.filter((e) => e.type === "message.started");
    const deltaEvents = allEvents.filter((e) => e.type === "message.delta") as MessageDeltaEvent[];
    const completedEvents = allEvents.filter((e) => e.type === "message.completed");

    expect(startedEvents).toHaveLength(1);
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents[0].deltaText).toBe("Hel");
    expect(deltaEvents[1].deltaText).toBe("lo");
    expect(completedEvents).toHaveLength(1);
  });

  it("Test 3: thought part emits thinking.delta instead of message.delta (§Step 6)", () => {
    const context = makeContext();
    const state = makeState();

    const chunk: GenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Thinking about mathematical solution...", thought: true }],
          },
        },
      ],
    } as unknown as GenerateContentResponse;

    const events = translateGeminiStreamChunk(chunk, context, state);

    expect(events).toHaveLength(2); // message.started + thinking.delta
    expect(events[0].type).toBe("message.started");
    expect(events[1].type).toBe("thinking.delta");
    expect((events[1] as ThinkingDeltaEvent).thinkingText).toBe(
      "Thinking about mathematical solution...",
    );
    expect(state.activeThinking).toBe(true);
  });

  it("Test 4: mixed thinking and text emits thinking.completed before text delta (§Step 6)", () => {
    const context = makeContext();
    const state = makeState();

    // 1. Thought chunk
    const chunk1: GenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "reasoning step", thought: true }],
          },
        },
      ],
    } as unknown as GenerateContentResponse;

    // 2. Normal text chunk
    const chunk2: GenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Here is the answer." }],
          },
        },
      ],
    } as unknown as GenerateContentResponse;

    const events1 = translateGeminiStreamChunk(chunk1, context, state);
    const events2 = translateGeminiStreamChunk(chunk2, context, state);

    expect(events1[1].type).toBe("thinking.delta");
    // Transition chunk: thinking.completed must precede message.delta
    expect(events2[0].type).toBe("thinking.completed");
    expect((events2[0] as ThinkingCompletedEvent).messageId).toBe(context.messageId);
    expect(events2[1].type).toBe("message.delta");
    expect((events2[1] as MessageDeltaEvent).deltaText).toBe("Here is the answer.");
    expect(state.activeThinking).toBe(false);
  });

  it("Test 5 & Test 6: function call parts translate to distinct canonical tool.call.requested events (§Step 7)", () => {
    const context = makeContext();
    const state = makeState();

    const chunk: GenerateContentResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "search_database",
                  args: { query: "orders" },
                  id: "call_db_1",
                },
              },
              {
                functionCall: {
                  name: "send_email",
                  args: { recipient: "user@test.com" },
                  id: "call_mail_2",
                },
              },
            ],
          },
        },
      ],
    } as unknown as GenerateContentResponse;

    const events = translateGeminiStreamChunk(chunk, context, state);

    expect(events[0].type).toBe("message.started");
    expect(events[1].type).toBe("tool.call.requested");
    expect(events[2].type).toBe("tool.call.requested");

    const tool1 = events[1] as ToolCallRequestedEvent;
    const tool2 = events[2] as ToolCallRequestedEvent;

    expect(tool1.toolName).toBe("search_database");
    expect(tool1.toolCallId).toBe("call_db_1");
    expect(tool1.input).toEqual({ query: "orders" });

    expect(tool2.toolName).toBe("send_email");
    expect(tool2.toolCallId).toBe("call_mail_2");
    expect(tool2.input).toEqual({ recipient: "user@test.com" });

    // Distinct call IDs preserved
    expect(tool1.toolCallId).not.toBe(tool2.toolCallId);
  });

  it("Test 7 & Test 8: final chunk with finishReason and usageMetadata emits message.completed (§Step 10, §Step 11)", () => {
    const context = makeContext();
    const state = makeState();

    // Start stream
    translateGeminiStreamChunk(
      {
        candidates: [{ content: { role: "model", parts: [{ text: "Done" }] } }],
      } as unknown as GenerateContentResponse,
      context,
      state,
    );

    // Final chunk with finish reason and token counts
    const chunkFinal: GenerateContentResponse = {
      candidates: [
        {
          finishReason: FinishReason.STOP,
          content: { role: "model", parts: [] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40,
      },
    } as unknown as GenerateContentResponse;

    const events = translateGeminiStreamChunk(chunkFinal, context, state);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message.completed");
    const completed = events[0] as MessageCompletedEvent;
    expect(completed.finishReason).toBe("end_turn");
    expect(completed.totalTokens).toBe(40);
    expect(state.hasEmittedCompleted).toBe(true);
  });

  it("Test 10: ten content chunks still produce exactly ONE message.started event (§Step 18)", () => {
    const context = makeContext();
    const state = makeState();

    const allEvents: AIEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const chunk: GenerateContentResponse = {
        candidates: [{ content: { role: "model", parts: [{ text: `chunk-${i}` }] } }],
      } as unknown as GenerateContentResponse;
      allEvents.push(...translateGeminiStreamChunk(chunk, context, state));
    }

    const startedCount = allEvents.filter((e) => e.type === "message.started").length;
    expect(startedCount).toBe(1);
  });

  it("Test 11: metadata-only chunks do not emit empty text deltas or premature start (§Step 18)", () => {
    const context = makeContext();
    const state = makeState();

    const chunkMetaOnly: GenerateContentResponse = {
      candidates: [],
      usageMetadata: { promptTokenCount: 10 },
    } as unknown as GenerateContentResponse;

    const events = translateGeminiStreamChunk(chunkMetaOnly, context, state);

    expect(events).toHaveLength(0);
    expect(state.hasEmittedStarted).toBe(false);
  });

  it("Test 12: event sequence numbers are strictly monotonic: sequence(n) < sequence(n+1) (§Step 18)", () => {
    const context = makeContext();
    const state = makeState(10); // starting at 10

    const chunk1: GenerateContentResponse = {
      candidates: [{ content: { role: "model", parts: [{ text: "A" }] } }],
    } as unknown as GenerateContentResponse;

    const chunk2: GenerateContentResponse = {
      candidates: [{ content: { role: "model", parts: [{ text: "B" }] } }],
    } as unknown as GenerateContentResponse;

    const chunk3: GenerateContentResponse = {
      candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [] } }],
    } as unknown as GenerateContentResponse;

    const events = [
      ...translateGeminiStreamChunk(chunk1, context, state),
      ...translateGeminiStreamChunk(chunk2, context, state),
      ...translateGeminiStreamChunk(chunk3, context, state),
    ];

    expect(events.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i].sequence).toBeLessThan(events[i + 1].sequence);
      expect(events[i + 1].sequence).toBe(events[i].sequence + 1);
    }
  });

  it("Test 13: translateGeminiStream async generator helper yields full concatenated event stream (§Step 18)", async () => {
    const context = makeContext();

    async function* mockStream(): AsyncIterable<GenerateContentResponse> {
      yield {
        candidates: [{ content: { role: "model", parts: [{ text: "One " }] } }],
      } as unknown as GenerateContentResponse;
      yield {
        candidates: [{ content: { role: "model", parts: [{ text: "Two" }] } }],
      } as unknown as GenerateContentResponse;
      yield {
        candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [] } }],
      } as unknown as GenerateContentResponse;
    }

    const emittedEvents = [];
    for await (const event of translateGeminiStream(mockStream(), context)) {
      emittedEvents.push(event);
    }

    expect(emittedEvents.map((e) => e.type)).toEqual([
      "message.started",
      "message.delta",
      "message.delta",
      "message.completed",
    ]);
  });

  it("Test 14: unexpected stream termination without finishReason does NOT falsely emit completion (§Step 18)", async () => {
    const context = makeContext();

    // Stream ends abruptly after one delta without a finishReason chunk
    async function* abruptStream(): AsyncIterable<GenerateContentResponse> {
      yield {
        candidates: [{ content: { role: "model", parts: [{ text: "Abrupt" }] } }],
      } as unknown as GenerateContentResponse;
    }

    const emittedEvents = [];
    for await (const event of translateGeminiStream(abruptStream(), context)) {
      emittedEvents.push(event);
    }

    // Must NOT falsely emit message.completed
    expect(emittedEvents.some((e) => e.type === "message.completed")).toBe(false);
  });

  it("maps Google finish reason codes accurately via translateGeminiFinishReason (§Step 10)", () => {
    expect(translateGeminiFinishReason("STOP")).toBe("end_turn");
    expect(translateGeminiFinishReason("MAX_TOKENS")).toBe("max_tokens");
    expect(translateGeminiFinishReason("SAFETY")).toBe("content_filter");
    expect(translateGeminiFinishReason("RECITATION")).toBe("content_filter");
    expect(translateGeminiFinishReason("BLOCKLIST")).toBe("content_filter");
    expect(translateGeminiFinishReason("MALFORMED_FUNCTION_CALL")).toBe("error");
    expect(translateGeminiFinishReason(undefined)).toBe("end_turn");
  });
});
