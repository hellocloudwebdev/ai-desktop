// PR11: packages/providers — Anthropic Request Translation Boundary
//
// Invariants:
//   - Translates canonical ChatRequest into Anthropic-native MessageCreateParams.
//   - Canonical roles (system, user, assistant, tool) mapped cleanly.
//   - System prompt is passed to the top-level 'system' parameter.
//   - Canonical ContentParts (text, image, tool_call, tool_result, thinking) mapped to native blocks.
//   - ToolDefinition parameters mapped to Anthropic input_schema.
//   - Throws UnsupportedCapabilityError if request asks for capabilities the model lacks.
//   - Zero Anthropic types escape this module.

import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest,
  ContentPart,
  ModelDefinition,
  ToolDefinition,
} from "@ai-desktop/ai-core";
import { UnsupportedCapabilityError } from "../core/provider-errors.js";

type AnthropicContentBlock = Anthropic.ContentBlockParam;

/**
 * Translates canonical ContentPart into Anthropic-native ContentBlockParam.
 */
function translateContentPart(part: ContentPart, model: ModelDefinition): AnthropicContentBlock {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };

    case "image":
      if (!model.capabilities.includes("vision")) {
        throw new UnsupportedCapabilityError("vision", undefined, {
          providerId: model.providerId,
          modelId: model.id,
        });
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: part.data,
        },
      };

    case "tool_call":
    case "tool_use":
      return {
        type: "tool_use",
        id: part.toolCallId,
        name: part.toolName,
        input: (part.arguments ?? {}) as Record<string, unknown>,
      };

    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
        is_error: part.isError,
      };

    case "thinking":
      return {
        type: "thinking" as const,
        thinking: part.thinking,
        signature: part.signature ?? "",
      } as unknown as AnthropicContentBlock;

    case "code":
      return {
        type: "text",
        text: part.language
          ? `\`\`\`${part.language}\n${part.code}\n\`\`\``
          : `\`\`\`\n${part.code}\n\`\`\``,
      };

    case "citation":
      return {
        type: "text",
        text: `[Citation: ${part.source}]${part.text ? ` "${part.text}"` : ""}`,
      };

    case "file":
    case "audio":
    case "video":
      throw new UnsupportedCapabilityError(
        part.type,
        `Anthropic Messages API does not currently support direct "${part.type}" parts`,
        {
          providerId: model.providerId,
          modelId: model.id,
        },
      );

    default:
      throw new Error(`Unsupported content part`);
  }
}

/**
 * Translates canonical ToolDefinition into Anthropic-native ToolParam.
 */
function translateToolDefinition(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      ...(tool.parameters as Record<string, unknown>),
    },
  };
}

/**
 * Translates a canonical ChatRequest into Anthropic.MessageCreateParamsStreaming.
 */
export function translateChatRequest(
  request: ChatRequest,
  model: ModelDefinition,
): Anthropic.MessageCreateParamsStreaming {
  const messages: Anthropic.MessageParam[] = [];

  // Extract system prompt from request or from system messages
  let systemPrompt = request.systemPrompt;

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const systemTexts = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${systemTexts}` : systemTexts;
      continue;
    }

    const nativeRole: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const nativeContent = msg.content.map((part) => translateContentPart(part, model));

    messages.push({
      role: nativeRole,
      content: nativeContent,
    });
  }

  const maxTokens = request.options?.maxTokens ?? model.maxOutputTokens ?? 4096;

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: model.id,
    messages,
    max_tokens: maxTokens,
    stream: true,
  };

  if (systemPrompt) {
    params.system = systemPrompt;
  }

  if (request.options?.temperature !== undefined) {
    params.temperature = request.options.temperature;
  }

  if (request.options?.topP !== undefined) {
    params.top_p = request.options.topP;
  }

  if (request.options?.stopSequences && request.options.stopSequences.length > 0) {
    params.stop_sequences = [...request.options.stopSequences];
  }

  if (request.tools && request.tools.length > 0) {
    if (!model.capabilities.includes("tool_use")) {
      throw new UnsupportedCapabilityError("tool_use", undefined, {
        providerId: model.providerId,
        modelId: model.id,
      });
    }
    params.tools = request.tools.map(translateToolDefinition);
  }

  if (request.options?.thinking?.enabled) {
    if (!model.capabilities.includes("thinking")) {
      throw new UnsupportedCapabilityError("thinking", undefined, {
        providerId: model.providerId,
        modelId: model.id,
      });
    }
    params.thinking = {
      type: "enabled",
      budget_tokens: request.options.thinking.budgetTokens ?? 1024,
    };
  }

  return params;
}
