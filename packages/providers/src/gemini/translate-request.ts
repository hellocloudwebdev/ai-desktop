// PR21.3: packages/providers — Gemini Request Translation Boundary
//
// Invariants (Step 41 / PR21.3):
//   1. Translates canonical ChatRequest into Gemini GenerateContentParameters.
//   2. Canonical user role -> "user", assistant role -> "model".
//   3. System prompt and system messages are extracted to config.systemInstruction.
//   4. Canonical ContentParts mapped to native Gemini Part objects.
//   5. ToolDefinition parameters mapped to FunctionDeclaration.
//   6. Enforces capability checks against ModelDefinition (vision, tool_use, thinking, structured_output).
//   7. Translates namespaced ModelId (gemini:gemini-2.5-flash) to native model ID (gemini-2.5-flash).
//   8. Pure translation only — zero API execution or cancellation handling here.

import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentParameters,
  Part,
  Schema,
} from "@google/genai";
import type {
  ChatRequest,
  ContentPart,
  ModelCapability,
  ModelDefinition,
  ToolDefinition,
} from "@ai-desktop/ai-core";
import { UnsupportedCapabilityError } from "../core/provider-errors.js";

/**
 * Translates a canonical ContentPart into a Gemini-native Part.
 */
function translateContentPart(part: ContentPart, model: ModelDefinition): Part {
  switch (part.type) {
    case "text":
      return { text: part.text };

    case "image":
      if (!model.capabilities.includes("vision")) {
        throw new UnsupportedCapabilityError("vision", undefined, {
          providerId: model.providerId,
          modelId: model.id,
        });
      }
      return {
        inlineData: {
          mimeType: part.mimeType,
          data: part.data,
        },
      };

    case "tool_call":
    case "tool_use":
      if (!model.capabilities.includes("tool_use")) {
        throw new UnsupportedCapabilityError("tool_use", undefined, {
          providerId: model.providerId,
          modelId: model.id,
        });
      }
      return {
        functionCall: {
          name: part.toolName,
          args: (part.arguments ?? {}) as Record<string, unknown>,
        },
      };

    case "tool_result":
      return {
        functionResponse: {
          name: String(part.toolCallId),
          response: {
            output: part.result,
          },
        },
      };

    case "thinking":
      if (!model.capabilities.includes("thinking")) {
        throw new UnsupportedCapabilityError("thinking", undefined, {
          providerId: model.providerId,
          modelId: model.id,
        });
      }
      return {
        text: part.thinking,
        thought: true,
      };

    case "code":
      return {
        text: part.language
          ? `\`\`\`${part.language}\n${part.code}\n\`\`\``
          : `\`\`\`\n${part.code}\n\`\`\``,
      };

    case "citation":
      return {
        text: `[Citation: ${part.source}]${part.text ? ` "${part.text}"` : ""}`,
      };

    case "audio":
    case "video":
    case "file":
      if (!model.capabilities.includes(part.type as ModelCapability)) {
        throw new UnsupportedCapabilityError(
          part.type,
          `Model "${model.id}" does not support "${part.type}" parts in chat requests`,
          {
            providerId: model.providerId,
            modelId: model.id,
          },
        );
      }
      if ("data" in part && typeof part.data === "string") {
        return {
          inlineData: {
            mimeType: part.mimeType,
            data: part.data,
          },
        };
      }
      if ("uri" in part && typeof part.uri === "string") {
        return {
          fileData: {
            fileUri: part.uri,
            mimeType: part.mimeType,
          },
        };
      }
      throw new Error(`Malformed "${part.type}" part: missing data or uri`);

    default:
      throw new Error(`Unsupported content part type`);
  }
}

/**
 * Translates a canonical ToolDefinition into a Gemini FunctionDeclaration.
 */
function translateToolDefinition(tool: ToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  };
}

/**
 * Translates a canonical ChatRequest into Gemini GenerateContentParameters.
 *
 * @param request Canonical, provider-neutral ChatRequest.
 * @param model ModelDefinition owning capabilities and native metadata.
 * @returns GenerateContentParameters consumable by GoogleGenAI models.generateContent / generateContentStream.
 */
export function translateGeminiRequest(
  request: ChatRequest,
  model: ModelDefinition,
): GenerateContentParameters {
  // 1. Model ID translation: map namespaced ID (gemini:gemini-2.5-flash) to native ID (gemini-2.5-flash)
  const nativeModel = (model.metadata?.nativeModelId as string) ?? model.id.replace(/^gemini:/, "");

  // 2. Extract system instructions (§Step 4)
  const systemParts: string[] = [];
  if (request.systemPrompt?.trim()) {
    systemParts.push(request.systemPrompt.trim());
  }
  for (const msg of request.messages) {
    if (msg.role === "system") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) {
          systemParts.push(part.text.trim());
        }
      }
    }
  }

  // 3. Map conversation messages (filtering out system messages, mapping assistant -> model)
  const conversationMessages = request.messages.filter((m) => m.role !== "system");
  if (conversationMessages.length === 0) {
    throw new Error("ChatRequest must contain at least one non-system message");
  }

  const contents: Content[] = conversationMessages.map((msg) => {
    let role: string;
    if (msg.role === "assistant") {
      role = "model";
    } else {
      // user and tool results map to "user" in Gemini conversation flow
      role = "user";
    }

    const parts: Part[] = msg.content.map((part) => translateContentPart(part, model));
    return {
      role,
      parts,
    };
  });

  // 4. Configure generation options and capabilities
  const config: GenerateContentConfig = {};

  if (systemParts.length > 0) {
    config.systemInstruction = systemParts.join("\n\n");
  }

  // Tools mapping (§Step 7)
  if (request.tools && request.tools.length > 0) {
    if (!model.capabilities.includes("tool_use")) {
      throw new UnsupportedCapabilityError("tool_use", undefined, {
        providerId: model.providerId,
        modelId: model.id,
      });
    }

    const functionDeclarations = request.tools.map(translateToolDefinition);
    config.tools = [{ functionDeclarations }];
  }

  // Thinking configuration (§Step 8)
  if (request.options?.thinking?.enabled) {
    if (!model.capabilities.includes("thinking")) {
      throw new UnsupportedCapabilityError(
        "thinking",
        `Model "${model.id}" does not support thinking capability`,
        {
          providerId: model.providerId,
          modelId: model.id,
        },
      );
    }

    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: request.options.thinking.budgetTokens,
    };
  }

  // Structured output configuration (§Step 9)
  const metadata = request.options?.metadata;
  if (metadata?.structuredOutput === true || metadata?.responseSchema) {
    if (!model.capabilities.includes("structured_output")) {
      throw new UnsupportedCapabilityError("structured_output", undefined, {
        providerId: model.providerId,
        modelId: model.id,
      });
    }

    config.responseMimeType = "application/json";
    if (metadata.responseSchema) {
      config.responseSchema = metadata.responseSchema as unknown as Schema;
    }
  }

  // General generation options (§Step 11)
  if (request.options?.temperature !== undefined) {
    config.temperature = request.options.temperature;
  }
  if (request.options?.topP !== undefined) {
    config.topP = request.options.topP;
  }
  if (request.options?.maxTokens !== undefined) {
    config.maxOutputTokens = request.options.maxTokens;
  } else if (model.maxOutputTokens !== undefined) {
    config.maxOutputTokens = model.maxOutputTokens;
  }
  if (request.options?.stopSequences && request.options.stopSequences.length > 0) {
    config.stopSequences = request.options.stopSequences;
  }

  return {
    model: nativeModel,
    contents,
    config: Object.keys(config).length > 0 ? config : undefined,
  };
}
