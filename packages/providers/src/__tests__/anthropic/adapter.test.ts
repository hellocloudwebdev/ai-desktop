import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createConversationId } from "@ai-desktop/shared";
import { asModelId, textPart, type AIEvent, type ChatRequest } from "@ai-desktop/ai-core";
import { AnthropicAdapter } from "../../anthropic/anthropic-adapter.js";
import { ANTHROPIC_MODELS } from "../../anthropic/anthropic-models.js";
import { ModelNotFoundError, ProviderConfigError } from "../../core/provider-errors.js";

describe("AnthropicAdapter: Contract Implementation & Cancellation", () => {
  const sonnetModel = ANTHROPIC_MODELS[0];

  it("initializes and validates configuration cleanly", async () => {
    const adapter = new AnthropicAdapter();

    await expect(
      adapter.initialize({
        providerId: adapter.providerId,
        endpointUrl: "https://api.anthropic.com",
        metadata: { apiKey: "test-key" },
      }),
    ).resolves.toBeUndefined();

    expect(adapter.client).toBeDefined();
  });

  it("rejects invalid configuration with ProviderConfigError", () => {
    const adapter = new AnthropicAdapter();
    const bad = adapter.validateConfig({
      providerId: adapter.providerId,
      endpointUrl: "ftp://invalid-scheme",
    });

    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(ProviderConfigError);
    }
  });

  it("lists canonical Anthropic models and discovers capabilities", async () => {
    const adapter = new AnthropicAdapter();
    const models = await adapter.listModels();

    expect(models.length).toBeGreaterThanOrEqual(3);
    const sonnet = models.find((m) => m.id === sonnetModel.id);
    expect(sonnet).toBeDefined();
    expect(adapter.supports(sonnetModel.id, "text_generation")).toBe(true);
    expect(adapter.supports(sonnetModel.id, "vision")).toBe(true);
    expect(adapter.supports(sonnetModel.id, "tool_use")).toBe(true);
  });

  it("propagates standard AbortSignal to underlying Anthropic client request", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    // Create mock Anthropic client that inspects options.signal
    const mockClient = {
      messages: {
        create: vi
          .fn()
          .mockImplementation((_params: unknown, options: { signal?: AbortSignal }) => {
            receivedSignal = options?.signal;
            async function* emptyStream() {}
            return emptyStream();
          }),
      },
    } as unknown as Anthropic;

    const adapter = new AnthropicAdapter({ client: mockClient });
    await adapter.initialize({
      providerId: adapter.providerId,
      metadata: { apiKey: "test-key" },
    });

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: sonnetModel.id,
      messages: [{ role: "user", content: [textPart("Hello")] }],
    };

    const stream = adapter.chat(request, controller.signal);
    for await (const event of stream) {
      void event;
    }

    expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("throws ModelNotFoundError for unrecognised models", async () => {
    const adapter = new AnthropicAdapter();
    await adapter.initialize({
      providerId: adapter.providerId,
      metadata: { apiKey: "test-key" },
    });

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: asModelId("unrecognized-model-xyz"),
      messages: [{ role: "user", content: [textPart("Hello")] }],
    };

    const stream = adapter.chat(request);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(ModelNotFoundError);
  });

  // Section 34.58: Minimum Real-API Smoke Test (Opt-in only via ANTHROPIC_SMOKE_TEST=1)
  describe.skipIf(!process.env.ANTHROPIC_SMOKE_TEST)("Opt-in Real API Smoke Test", () => {
    it("executes live request against real Anthropic API if key is present in environment", async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_SMOKE_TEST=1 requires ANTHROPIC_API_KEY to be set");
      }

      const adapter = new AnthropicAdapter();
      await adapter.initialize({
        providerId: adapter.providerId,
        metadata: { apiKey },
      });

      const request: ChatRequest = {
        conversationId: createConversationId(),
        modelId: sonnetModel.id,
        messages: [{ role: "user", content: [textPart("Say 'OK' and nothing else.")] }],
        options: { maxTokens: 10 },
      };

      const events: AIEvent[] = [];
      for await (const event of adapter.chat(request)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events[0].type).toBe("message.started");
      expect(events[events.length - 1].type).toBe("message.completed");
    });
  });
});
