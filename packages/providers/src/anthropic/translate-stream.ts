// PR11: packages/providers — Anthropic Stream Translation Boundary
//
// Invariants:
//   - Translates Anthropic SDK stream chunks into canonical AIEvents:
//       message.started
//       message.delta (text and thinking)
//       tool.call.requested
//       message.completed
//   - Preserves message and sequence ordering.
//   - Zero Anthropic types escape this module.

import type Anthropic from "@anthropic-ai/sdk";
import type { ConversationId, MessageId } from "@ai-desktop/shared";
import { asToolCallId, now } from "@ai-desktop/shared";
import type {
  AIEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageStartedEvent,
  ToolCallRequestedEvent,
} from "@ai-desktop/ai-core";
import { createEventId } from "@ai-desktop/ai-core";

export interface StreamTranslationContext {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  initialSequence?: number;
}

interface PartialToolCall {
  id: string;
  name: string;
  jsonChunks: string[];
}

/**
 * Translates an Anthropic RawMessageStreamEvent async stream into a stream of canonical AIEvents.
 */
export async function* translateAnthropicStream(
  anthropicStream: AsyncIterable<Anthropic.MessageStreamEvent>,
  context: StreamTranslationContext,
): AsyncIterable<AIEvent> {
  const { conversationId, messageId } = context;
  let sequence = context.initialSequence ?? 0;

  // Track active tool calls being constructed across stream blocks
  const activeToolCalls = new Map<number, PartialToolCall>();
  let hasEmittedStarted = false;
  let finishReason: string | undefined;
  let totalTokens: number | undefined;

  for await (const chunk of anthropicStream) {
    switch (chunk.type) {
      case "message_start": {
        if (!hasEmittedStarted) {
          hasEmittedStarted = true;
          const startedEvent: MessageStartedEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.started",
            category: "core",
            messageId,
            role: "assistant",
            content: [],
          };
          yield startedEvent;
        }
        if (chunk.message.usage) {
          totalTokens =
            (chunk.message.usage.input_tokens ?? 0) + (chunk.message.usage.output_tokens ?? 0);
        }
        break;
      }

      case "content_block_start": {
        if (!hasEmittedStarted) {
          hasEmittedStarted = true;
          yield {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.started",
            category: "core",
            messageId,
            role: "assistant",
            content: [],
          } as MessageStartedEvent;
        }

        const block = chunk.content_block;
        if (block.type === "tool_use") {
          activeToolCalls.set(chunk.index, {
            id: block.id,
            name: block.name,
            jsonChunks: [],
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = chunk.delta;

        if (delta.type === "text_delta") {
          const deltaEvent: MessageDeltaEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.delta",
            category: "core",
            messageId,
            deltaText: delta.text,
          };
          yield deltaEvent;
        } else if (delta.type === "thinking_delta") {
          // Anthropic extended thinking block
          const thinkingText =
            "thinking" in delta && typeof (delta as { thinking: unknown }).thinking === "string"
              ? (delta as { thinking: string }).thinking
              : "";
          const deltaEvent: MessageDeltaEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.delta",
            category: "core",
            messageId,
            deltaText: thinkingText,
          };
          yield deltaEvent;
        } else if (delta.type === "input_json_delta") {
          const active = activeToolCalls.get(chunk.index);
          if (active) {
            const partialJson =
              "partial_json" in delta &&
              typeof (delta as { partial_json: unknown }).partial_json === "string"
                ? (delta as { partial_json: string }).partial_json
                : "";
            active.jsonChunks.push(partialJson);
          }
        }
        break;
      }

      case "content_block_stop": {
        const active = activeToolCalls.get(chunk.index);
        if (active) {
          let parsedInput: unknown = {};
          const fullJson = active.jsonChunks.join("");
          if (fullJson.trim().length > 0) {
            try {
              parsedInput = JSON.parse(fullJson);
            } catch {
              parsedInput = { raw: fullJson };
            }
          }

          const toolCallEvent: ToolCallRequestedEvent = {
            eventId: createEventId(),
            conversationId,
            sequence: sequence++,
            schemaVersion: 1,
            timestamp: now(),
            type: "tool.call.requested",
            category: "capability",
            toolCallId: asToolCallId(active.id),
            toolName: active.name,
            toolSource: "builtin",
            toolRuntime: "in_process",
            input: parsedInput,
          };
          yield toolCallEvent;
          activeToolCalls.delete(chunk.index);
        }
        break;
      }

      case "message_delta": {
        if (chunk.delta.stop_reason) {
          finishReason = chunk.delta.stop_reason;
        }
        if (chunk.usage && chunk.usage.output_tokens) {
          totalTokens = (totalTokens ?? 0) + chunk.usage.output_tokens;
        }
        break;
      }

      case "message_stop": {
        const completedEvent: MessageCompletedEvent = {
          eventId: createEventId(),
          conversationId,
          sequence: sequence++,
          schemaVersion: 1,
          timestamp: now(),
          type: "message.completed",
          category: "core",
          messageId,
          finishReason: finishReason ?? "end_turn",
          totalTokens,
        };
        yield completedEvent;
        break;
      }

      default:
        // Safely ignore unrecognized stream chunks
        break;
    }
  }

  // Safety check: if stream closed without explicit message_stop, emit message.completed
  if (hasEmittedStarted && !finishReason) {
    yield {
      eventId: createEventId(),
      conversationId,
      sequence: sequence++,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId,
      finishReason: "end_turn",
      totalTokens,
    } as MessageCompletedEvent;
  }
}
