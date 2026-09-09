// PR21.4: packages/providers — Gemini Streaming Translation Boundary
//
// Invariants (Step 41 / PR21.4):
//   1. Translates native Gemini GenerateContentResponse stream chunks into canonical AIEvents.
//   2. Emits message.started on the first chunk containing content (exactly once per message).
//   3. Normal text parts (part.text && !part.thought) -> message.delta.
//   4. Thought text parts (part.text && part.thought === true) -> thinking.delta.
//   5. When thoughts end, emits thinking.completed before transitioning to text or tool calls.
//   6. Native FunctionCall parts -> canonical tool.call.requested (with unique IDs preserved).
//   7. When finishReason is present on the candidate, emits message.completed with token usage.
//   8. Metadata-only chunks without content do not emit empty text deltas or premature completions.
//   9. Stream iterator termination without finishReason does not synthesize a false completion.
//  10. Pure translation: zero tool execution, zero cancellation logic, zero SDK types escape.

import type { GenerateContentResponse } from "@google/genai";
import {
  asToolCallId,
  createToolCallId,
  now,
  type ConversationId,
  type MessageId,
  type TaskId,
} from "@ai-desktop/shared";
import {
  createEventId,
  type AIEvent,
  type MessageCompletedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type ModelId,
  type ThinkingCompletedEvent,
  type ThinkingDeltaEvent,
  type ToolCallRequestedEvent,
} from "@ai-desktop/ai-core";

export interface GeminiStreamContext {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly modelId?: ModelId;
  readonly taskId?: TaskId;
  initialSequence?: number;
}

export interface GeminiStreamState {
  hasEmittedStarted: boolean;
  hasEmittedCompleted: boolean;
  activeThinking: boolean;
  sequence: number;
  finishReason?: string;
  totalTokens?: number;
}

/**
 * Maps Google's finish reason string into canonical finish reason format (§Step 10).
 */
export function translateGeminiFinishReason(reason?: string): string {
  if (!reason) {
    return "end_turn";
  }
  switch (reason.toUpperCase()) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
      return "error";
    default:
      return reason.toLowerCase();
  }
}

/**
 * Translates a single Gemini GenerateContentResponse chunk into canonical AIEvents (§Step 3).
 *
 * @param chunk Native GenerateContentResponse chunk yielded by generateContentStream.
 * @param context Conversation and message identity context.
 * @param state Mutable state tracking stream lifecycle progress.
 * @returns Array of canonical AIEvents for this chunk.
 */
export function translateGeminiStreamChunk(
  chunk: GenerateContentResponse,
  context: GeminiStreamContext,
  state: GeminiStreamState,
): AIEvent[] {
  const events: AIEvent[] = [];
  const candidate = chunk.candidates?.[0];

  // 1. Update token usage metadata if present (§Step 11)
  if (chunk.usageMetadata?.totalTokenCount !== undefined) {
    state.totalTokens = chunk.usageMetadata.totalTokenCount;
  } else if (chunk.usageMetadata?.candidatesTokenCount !== undefined) {
    state.totalTokens = (state.totalTokens ?? 0) + chunk.usageMetadata.candidatesTokenCount;
  }

  // 2. Track finish reason if provided (§Step 10)
  if (candidate?.finishReason) {
    state.finishReason = translateGeminiFinishReason(candidate.finishReason);
  }

  const parts = candidate?.content?.parts ?? [];

  // 3. Check for meaningful content to trigger message.started (§Step 4)
  const hasMeaningfulContent = parts.some(
    (p) => Boolean(p.text && p.text.length > 0) || Boolean(p.functionCall),
  );

  if (hasMeaningfulContent && !state.hasEmittedStarted) {
    state.hasEmittedStarted = true;
    const startedEvent: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: context.conversationId,
      sequence: state.sequence++,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: context.messageId,
      role: "assistant",
      content: [],
    };
    events.push(startedEvent);
  }

  // 4. Translate structured content parts (§Step 5, 6, 7)
  for (const part of parts) {
    // Thought content part (§Step 6)
    if (part.text && part.thought === true) {
      state.activeThinking = true;
      const thinkingEvent: ThinkingDeltaEvent = {
        eventId: createEventId(),
        conversationId: context.conversationId,
        sequence: state.sequence++,
        schemaVersion: 1,
        timestamp: now(),
        type: "thinking.delta",
        category: "core",
        messageId: context.messageId,
        thinkingText: part.text,
      };
      events.push(thinkingEvent);
      continue;
    }

    // Normal text delta (§Step 5)
    if (part.text && !part.thought && part.text.length > 0) {
      // If thinking was active previously, emit thinking.completed before normal text
      if (state.activeThinking) {
        state.activeThinking = false;
        const thinkingCompleted: ThinkingCompletedEvent = {
          eventId: createEventId(),
          conversationId: context.conversationId,
          sequence: state.sequence++,
          schemaVersion: 1,
          timestamp: now(),
          type: "thinking.completed",
          category: "core",
          messageId: context.messageId,
        };
        events.push(thinkingCompleted);
      }

      const deltaEvent: MessageDeltaEvent = {
        eventId: createEventId(),
        conversationId: context.conversationId,
        sequence: state.sequence++,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: context.messageId,
        deltaText: part.text,
      };
      events.push(deltaEvent);
      continue;
    }

    // Function/tool call part (§Step 7)
    if (part.functionCall) {
      if (state.activeThinking) {
        state.activeThinking = false;
        const thinkingCompleted: ThinkingCompletedEvent = {
          eventId: createEventId(),
          conversationId: context.conversationId,
          sequence: state.sequence++,
          schemaVersion: 1,
          timestamp: now(),
          type: "thinking.completed",
          category: "core",
          messageId: context.messageId,
        };
        events.push(thinkingCompleted);
      }

      const callId = part.functionCall.id ? asToolCallId(part.functionCall.id) : createToolCallId();
      const toolCallEvent: ToolCallRequestedEvent = {
        eventId: createEventId(),
        conversationId: context.conversationId,
        sequence: state.sequence++,
        schemaVersion: 1,
        timestamp: now(),
        type: "tool.call.requested",
        category: "capability",
        toolCallId: callId,
        toolName: part.functionCall.name ?? "unnamed_tool",
        toolSource: "builtin",
        toolRuntime: "in_process",
        input: (part.functionCall.args ?? {}) as Record<string, unknown>,
      };
      events.push(toolCallEvent);
      continue;
    }
  }

  // 5. Completion event when finishReason is present and stream was started (§Step 10, §Step 14)
  if (candidate?.finishReason && !state.hasEmittedCompleted && state.hasEmittedStarted) {
    if (state.activeThinking) {
      state.activeThinking = false;
      const thinkingCompleted: ThinkingCompletedEvent = {
        eventId: createEventId(),
        conversationId: context.conversationId,
        sequence: state.sequence++,
        schemaVersion: 1,
        timestamp: now(),
        type: "thinking.completed",
        category: "core",
        messageId: context.messageId,
      };
      events.push(thinkingCompleted);
    }

    state.hasEmittedCompleted = true;
    const completedEvent: MessageCompletedEvent = {
      eventId: createEventId(),
      conversationId: context.conversationId,
      sequence: state.sequence++,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: context.messageId,
      finishReason: state.finishReason ?? "end_turn",
      totalTokens: state.totalTokens,
    };
    events.push(completedEvent);
  }

  return events;
}

/**
 * Translates a native Gemini AsyncIterable stream of GenerateContentResponse chunks
 * into an AsyncIterable stream of canonical AIEvents (§Step 3).
 */
export async function* translateGeminiStream(
  stream: AsyncIterable<GenerateContentResponse>,
  context: GeminiStreamContext,
): AsyncIterable<AIEvent> {
  const state: GeminiStreamState = {
    hasEmittedStarted: false,
    hasEmittedCompleted: false,
    activeThinking: false,
    sequence: context.initialSequence ?? 0,
  };

  for await (const chunk of stream) {
    const events = translateGeminiStreamChunk(chunk, context, state);
    for (const event of events) {
      yield event;
    }
  }
}
