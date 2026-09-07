import { describe, expect, it } from "vitest";
import { createConversationId, createToolCallId } from "@ai-desktop/shared";
import {
  asModelId,
  imagePart,
  textPart,
  toolCallPart,
  toolResultPart,
  type ChatRequest,
  type ModelDefinition,
} from "@ai-desktop/ai-core";
import { ANTHROPIC_MODELS } from "../../anthropic/anthropic-models.js";
import { translateChatRequest } from "../../anthropic/translate-request.js";
import { UnsupportedCapabilityError } from "../../core/provider-errors.js";

describe("Anthropic: Request Translation Boundary", () => {
  const sonnetModel = ANTHROPIC_MODELS.find((m) => m.displayName.includes("Sonnet"))!;
  const haikuModel = ANTHROPIC_MODELS.find((m) => m.displayName.includes("Haiku"))!;

  it("translates user and assistant messages with text content", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: sonnetModel.id,
      systemPrompt: "You are an expert coder.",
      messages: [
        { role: "user", content: [textPart("How do I write a loop?")] },
        { role: "assistant", content: [textPart("Use for...of.")] },
        { role: "user", content: [textPart("Give an example.")] },
      ],
      options: {
        temperature: 0.7,
        maxTokens: 2048,
      },
    };

    const nativeParams = translateChatRequest(request, sonnetModel);

    expect(nativeParams.model).toBe(sonnetModel.id);
    expect(nativeParams.system).toBe("You are an expert coder.");
    expect(nativeParams.temperature).toBe(0.7);
    expect(nativeParams.max_tokens).toBe(2048);
    expect(nativeParams.stream).toBe(true);

    expect(nativeParams.messages).toHaveLength(3);
    expect(nativeParams.messages[0].role).toBe("user");
    expect(nativeParams.messages[1].role).toBe("assistant");
    expect(nativeParams.messages[2].role).toBe("user");
  });

  it("translates vision image parts when model supports vision", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: sonnetModel.id,
      messages: [
        {
          role: "user",
          content: [
            textPart("Describe this image"),
            imagePart("image/png", "base64-encoded-image-bytes"),
          ],
        },
      ],
    };

    const nativeParams = translateChatRequest(request, sonnetModel);
    expect(nativeParams.messages[0].content).toHaveLength(2);

    const firstMsgContent = Array.isArray(nativeParams.messages[0].content)
      ? nativeParams.messages[0].content
      : [];
    const imageBlock = firstMsgContent[1] as {
      type: string;
      source: { type: string; media_type: string; data: string };
    };
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.source.type).toBe("base64");
    expect(imageBlock.source.media_type).toBe("image/png");
    expect(imageBlock.source.data).toBe("base64-encoded-image-bytes");
  });

  it("throws UnsupportedCapabilityError when image input is given to a model without vision", () => {
    const textOnlyModel: ModelDefinition = {
      id: asModelId("text-only-model"),
      providerId: sonnetModel.providerId,
      displayName: "Text Only",
      contextWindow: 100000,
      capabilities: ["text_generation", "streaming"],
    };

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: textOnlyModel.id,
      messages: [
        {
          role: "user",
          content: [imagePart("image/png", "base64-data")],
        },
      ],
    };

    expect(() => translateChatRequest(request, textOnlyModel)).toThrow(UnsupportedCapabilityError);
  });

  it("translates tools and tool_use / tool_result content parts", () => {
    const callId = createToolCallId();

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: sonnetModel.id,
      messages: [
        {
          role: "assistant",
          content: [toolCallPart(callId, "calc", { expr: "2+2" })],
        },
        {
          role: "user",
          content: [toolResultPart(callId, { result: 4 })],
        },
      ],
      tools: [
        {
          name: "calc",
          description: "Calculator",
          source: "builtin",
          runtime: "in_process",
          parameters: {
            properties: { expr: { type: "string" } },
            required: ["expr"],
          },
        },
      ],
    };

    const nativeParams = translateChatRequest(request, sonnetModel);

    expect(nativeParams.tools).toHaveLength(1);
    const firstTool = nativeParams.tools![0] as { name: string; description?: string };
    expect(firstTool.name).toBe("calc");
    expect(firstTool.description).toBe("Calculator");

    const assistantContent = Array.isArray(nativeParams.messages[0].content)
      ? nativeParams.messages[0].content
      : [];
    const firstBlock = assistantContent[0] as { type: string; id: string };
    expect(firstBlock.type).toBe("tool_use");
    expect(firstBlock.id).toBe(callId);

    const userContent = Array.isArray(nativeParams.messages[1].content)
      ? nativeParams.messages[1].content
      : [];
    const secondBlock = userContent[0] as { type: string; tool_use_id: string };
    expect(secondBlock.type).toBe("tool_result");
    expect(secondBlock.tool_use_id).toBe(callId);
  });

  it("translates thinking budget options when model supports thinking", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: sonnetModel.id,
      messages: [{ role: "user", content: [textPart("Think carefully")] }],
      options: {
        thinking: { enabled: true, budgetTokens: 2048 },
      },
    };

    const nativeParams = translateChatRequest(request, sonnetModel);
    expect(nativeParams.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
  });

  it("throws UnsupportedCapabilityError if thinking is requested on a model lacking it", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: haikuModel.id, // Haiku catalog does not have thinking
      messages: [{ role: "user", content: [textPart("Think")] }],
      options: {
        thinking: { enabled: true, budgetTokens: 1024 },
      },
    };

    expect(() => translateChatRequest(request, haikuModel)).toThrow(UnsupportedCapabilityError);
  });
});
