import { describe, expect, it } from "vitest";
import type { Content, Tool } from "@google/genai";
import { createConversationId, createMessageId, createToolCallId } from "@ai-desktop/shared";
import {
  asModelId,
  textPart,
  type ChatRequest,
  type ModelDefinition,
  type ToolDefinition,
} from "@ai-desktop/ai-core";
import { UnsupportedCapabilityError } from "../core/provider-errors.js";
import { GEMINI_MODEL_MAP, GEMINI_PROVIDER_ID } from "./gemini-models.js";
import { translateGeminiRequest } from "./translate-request.js";

const flashModel = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash")!;
const flashLiteModel = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-flash-lite")!;
const proModel = GEMINI_MODEL_MAP.get("gemini:gemini-2.5-pro")!;

describe("packages/providers: Gemini Request Translation (PR21.3)", () => {
  it("translates text-only user request into native Gemini parameters", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      messages: [
        {
          id: createMessageId(),
          role: "user",
          content: [textPart("What is the capital of France?")],
        },
      ],
    };

    const nativeParams = translateGeminiRequest(request, flashModel);

    // 1. Model ID translated to Google native ID (§Step 10)
    expect(nativeParams.model).toBe("gemini-2.5-flash");
    expect(nativeParams.model).not.toContain("gemini:");

    // 2. Contents structure (§Step 4)
    const contents = nativeParams.contents as Content[];
    expect(contents).toHaveLength(1);
    const firstContent = contents[0];
    expect(firstContent.role).toBe("user");
    expect(firstContent.parts).toHaveLength(1);
    expect(firstContent.parts![0]).toEqual({ text: "What is the capital of France?" });
  });

  it("extracts systemPrompt and system messages into config.systemInstruction (§Step 4)", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      systemPrompt: "You are a concise mathematics tutor.",
      messages: [
        {
          id: createMessageId(),
          role: "system",
          content: [textPart("Always double-check arithmetic.")],
        },
        {
          id: createMessageId(),
          role: "user",
          content: [textPart("What is 15 * 6?")],
        },
      ],
    };

    const nativeParams = translateGeminiRequest(request, flashModel);

    expect(nativeParams.config?.systemInstruction).toBe(
      "You are a concise mathematics tutor.\n\nAlways double-check arithmetic.",
    );

    // System messages must not appear as conversation turns in contents (§Step 4)
    const contents = nativeParams.contents as Content[];
    expect(contents.length).toBe(1);
    expect(contents[0].role).toBe("user");
  });

  it("maps assistant role to 'model' and handles multi-turn conversations (§Step 4)", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      messages: [
        {
          id: createMessageId(),
          role: "user",
          content: [textPart("Hello")],
        },
        {
          id: createMessageId(),
          role: "assistant",
          content: [textPart("Hi! How can I help you today?")],
        },
        {
          id: createMessageId(),
          role: "user",
          content: [textPart("Tell me a joke")],
        },
      ],
    };

    const nativeParams = translateGeminiRequest(request, flashModel);

    const contents = nativeParams.contents as Content[];
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts![0].text).toBe("Hello");
    expect(contents[1].role).toBe("model");
    expect(contents[1].parts![0].text).toBe("Hi! How can I help you today?");
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts![0].text).toBe("Tell me a joke");
  });

  it("translates multimodal inline image parts and enforces vision capability (§Step 6)", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: proModel.id,
      messages: [
        {
          id: createMessageId(),
          role: "user",
          content: [
            textPart("Describe this image"),
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            },
          ],
        },
      ],
    };

    const nativeParams = translateGeminiRequest(request, proModel);
    const parts = (nativeParams.contents as Content[])[0].parts!;

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: "Describe this image" });
    expect(parts[1]).toEqual({
      inlineData: {
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    });

    // Check unsupported vision rejection on text-only model
    const textOnlyModel: ModelDefinition = {
      id: asModelId("gemini:text-only"),
      providerId: GEMINI_PROVIDER_ID,
      displayName: "Text Only",
      contextWindow: 10000,
      capabilities: ["text_generation", "streaming"],
    };

    expect(() => translateGeminiRequest(request, textOnlyModel)).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it("translates canonical ToolDefinitions into Gemini FunctionDeclarations (§Step 7)", () => {
    const tool: ToolDefinition = {
      name: "get_weather",
      description: "Get the current weather for a city",
      source: "builtin",
      runtime: "in_process",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
        required: ["location"],
      },
    };

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      messages: [
        {
          id: createMessageId(),
          role: "user",
          content: [textPart("What is the weather in Tokyo?")],
        },
      ],
      tools: [tool],
    };

    const nativeParams = translateGeminiRequest(request, flashModel);

    expect(nativeParams.config?.tools).toBeDefined();
    const tools = nativeParams.config?.tools as Tool[];
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations).toHaveLength(1);
    expect(tools[0].functionDeclarations![0]).toEqual({
      name: "get_weather",
      description: "Get the current weather for a city",
      parametersJsonSchema: tool.parameters,
    });
  });

  it("translates tool call and tool result parts in conversation history", () => {
    const toolCallId = createToolCallId();
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      messages: [
        {
          id: createMessageId(),
          role: "assistant",
          content: [
            {
              type: "tool_call",
              toolCallId,
              toolName: "get_weather",
              arguments: { location: "Tokyo" },
            },
          ],
        },
        {
          id: createMessageId(),
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId,
              result: { temperature: 22, condition: "Sunny" },
            },
          ],
        },
      ],
    };

    const nativeParams = translateGeminiRequest(request, flashModel);
    const contents = nativeParams.contents as Content[];

    // 1. Tool call from model
    expect(contents[0].role).toBe("model");
    expect(contents[0].parts![0]).toEqual({
      functionCall: {
        name: "get_weather",
        args: { location: "Tokyo" },
      },
    });

    // 2. Tool result from user
    expect(contents[1].role).toBe("user");
    expect(contents[1].parts![0]).toEqual({
      functionResponse: {
        name: String(toolCallId),
        response: {
          output: { temperature: 22, condition: "Sunny" },
        },
      },
    });
  });

  it("translates thinking configuration and rejects when model lacks capability (§Step 8)", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      messages: [{ id: createMessageId(), role: "user", content: [textPart("Solve equation")] }],
      options: {
        thinking: {
          enabled: true,
          budgetTokens: 2048,
        },
      },
    };

    // 1. Flash model supports thinking
    const flashParams = translateGeminiRequest(request, flashModel);
    expect(flashParams.config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    });

    // 2. Flash-Lite model does NOT support thinking -> throws UnsupportedCapabilityError (§Step 8)
    expect(() => translateGeminiRequest(request, flashLiteModel)).toThrow(
      UnsupportedCapabilityError,
    );
  });

  it("translates structured output and generation options (§Step 9, §Step 11)", () => {
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
    };

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      messages: [{ id: createMessageId(), role: "user", content: [textPart("Output JSON")] }],
      options: {
        temperature: 0.7,
        topP: 0.95,
        maxTokens: 4096,
        stopSequences: ["END"],
        metadata: {
          structuredOutput: true,
          responseSchema: schema,
        },
      },
    };

    const nativeParams = translateGeminiRequest(request, flashModel);

    expect(nativeParams.config?.temperature).toBe(0.7);
    expect(nativeParams.config?.topP).toBe(0.95);
    expect(nativeParams.config?.maxOutputTokens).toBe(4096);
    expect(nativeParams.config?.stopSequences).toEqual(["END"]);
    expect(nativeParams.config?.responseMimeType).toBe("application/json");
    expect(nativeParams.config?.responseSchema).toEqual(schema);
  });

  it("throws error if request contains no non-system conversation messages", () => {
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: flashModel.id,
      systemPrompt: "System instruction only",
      messages: [],
    };

    expect(() => translateGeminiRequest(request, flashModel)).toThrow(
      "ChatRequest must contain at least one non-system message",
    );
  });
});
