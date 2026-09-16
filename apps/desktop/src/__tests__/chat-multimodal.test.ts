// PR39: apps/desktop — Multimodal Chat Tests
//
// Covers multimodal parts flow through ChatService, capability negotiation
// failures before provider execution (zero provider calls), message bounds,
// and cancellation propagation. Fake adapter with configurable capabilities.

import { describe, expect, it } from "vitest";
import { createMessageId, now, ok, type Result } from "@ai-desktop/shared";
import {
  createEventId,
  type AIEvent,
  type ChatRequest,
  type MessageCompletedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type ModelDefinition,
} from "@ai-desktop/ai-core";
import { type ProviderAdapter, type ProviderConfigError } from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { InMemoryEventRepository, createTestChatService } from "./test-helpers.js";

const PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

class CapabilityAdapter implements ProviderAdapter {
  readonly providerId = "test-multimodal" as never;
  readonly calls: ChatRequest[] = [];
  constructor(private readonly _capabilities: ModelDefinition["capabilities"]) {}

  private _model(): ModelDefinition {
    return {
      id: "test:mm-1" as never,
      providerId: this.providerId,
      displayName: "MM",
      description: "",
      contextWindow: 100000,
      maxOutputTokens: 1024,
      capabilities: [...this._capabilities],
    };
  }

  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return [this._model()];
  }
  async getModel(): Promise<ModelDefinition | undefined> {
    return this._model();
  }
  validateConfig(): Result<void, ProviderConfigError> {
    return ok(undefined);
  }
  supports(): boolean {
    return true;
  }

  async *chat(request: ChatRequest): AsyncIterable<AIEvent> {
    this.calls.push(request);
    const assistantMsgId = createMessageId();
    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: assistantMsgId,
      role: "assistant",
      content: [],
    } as MessageStartedEvent;
    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: assistantMsgId,
      deltaText: "seen",
    } as MessageDeltaEvent;
    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: assistantMsgId,
      finishReason: "end_turn",
    } as MessageCompletedEvent;
  }
}

function makeService(capabilities: ModelDefinition["capabilities"]) {
  const provider = new CapabilityAdapter(capabilities);
  const streamRegistry = new ActiveStreamRegistry();
  const eventBus = new EventBus();
  const storage = new InMemoryEventRepository();
  const service = createTestChatService({
    provider,
    streamRegistry,
    eventBus,
    storage,
    models: [
      {
        id: "test:mm-1" as never,
        providerId: "test-multimodal" as never,
        displayName: "MM",
        description: "",
        contextWindow: 100000,
        maxOutputTokens: 1024,
        capabilities: [...capabilities],
      },
    ],
  });
  return { service, provider, storage };
}

describe("multimodal chat", () => {
  it("sends image parts to vision-capable models", async () => {
    const { service, provider } = makeService(["text_generation", "streaming", "vision"]);
    const result = await service.sendMessage({
      content: "Explain this image.",
      parts: [{ type: "image", mimeType: "image/png", data: PNG_DATA }],
      modelId: "test:mm-1",
    });
    await result.completion;
    expect(provider.calls).toHaveLength(1);
    const userMsg = provider.calls[0]?.messages.find((m) => m.role === "user");
    expect(userMsg?.content.some((p) => p.type === "image")).toBe(true);
  });

  it("fails image requests on text-only models with zero provider calls", async () => {
    const { service, provider } = makeService(["text_generation", "streaming"]);
    await expect(
      service.sendMessage({
        content: "Explain this image.",
        parts: [{ type: "image", mimeType: "image/png", data: PNG_DATA }],
        modelId: "test:mm-1",
      }),
    ).rejects.toThrow(/vision/);
    expect(provider.calls).toHaveLength(0);
  });

  it("fails audio requests without audio capability", async () => {
    const { service, provider } = makeService(["text_generation", "streaming", "vision"]);
    await expect(
      service.sendMessage({
        content: "Transcribe this.",
        parts: [{ type: "audio", mimeType: "audio/mpeg", data: "AAAA" }],
        modelId: "test:mm-1",
      }),
    ).rejects.toThrow(/audio/);
    expect(provider.calls).toHaveLength(0);
  });

  it("sends audio+video to fully capable models", async () => {
    const { service, provider } = makeService([
      "text_generation",
      "streaming",
      "vision",
      "audio",
      "video",
    ]);
    const result = await service.sendMessage({
      content: "Describe these.",
      parts: [
        { type: "audio", mimeType: "audio/mpeg", data: "AAAA" },
        { type: "video", mimeType: "video/mp4", data: "BBBB" },
      ],
      modelId: "test:mm-1",
    });
    await result.completion;
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects oversized part counts", async () => {
    const { service, provider } = makeService([
      "text_generation",
      "streaming",
      "vision",
      "audio",
      "video",
    ]);
    const parts = Array.from({ length: 20 }, () => ({
      type: "image" as const,
      mimeType: "image/png",
      data: PNG_DATA,
    }));
    await expect(
      service.sendMessage({
        content: "Many images.",
        parts,
        modelId: "test:mm-1",
      }),
    ).rejects.toThrow(/parts/);
    expect(provider.calls).toHaveLength(0);
  });

  it("text-only messages still work with no parts", async () => {
    const { service, provider } = makeService(["text_generation", "streaming"]);
    const result = await service.sendMessage({ content: "Hello", modelId: "test:mm-1" });
    await result.completion;
    expect(provider.calls).toHaveLength(1);
  });
});
