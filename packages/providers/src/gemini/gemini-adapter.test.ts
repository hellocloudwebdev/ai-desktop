import { describe, expect, it } from "vitest";
import {
  FinishReason,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type GoogleGenAI,
} from "@google/genai";
import { createConversationId } from "@ai-desktop/shared";
import {
  asModelId,
  textPart,
  type AIEvent,
  type ChatRequest,
  type MessageCompletedEvent,
  type ProviderId,
} from "@ai-desktop/ai-core";
import { ModelNotFoundError, ProviderConfigError } from "../core/provider-errors.js";
import { GEMINI_MODELS, GEMINI_PROVIDER_ID } from "./gemini-models.js";
import { GeminiAdapter } from "./gemini-adapter.js";

describe("packages/providers: GeminiAdapter (PR21.6)", () => {
  it("declares providerId as 'gemini' (§PR21.6.1)", () => {
    const adapter = new GeminiAdapter();
    expect(adapter.providerId).toBe("gemini");
    expect(adapter.providerId).toBe(GEMINI_PROVIDER_ID);
  });

  it("lists all canonical Gemini models (§PR21.6.5)", async () => {
    const adapter = new GeminiAdapter();
    const models = await adapter.listModels();

    expect(models).toHaveLength(GEMINI_MODELS.length);
    expect(models.map((m) => m.id)).toContain("gemini:gemini-2.5-flash");
    expect(models.map((m) => m.id)).toContain("gemini:gemini-2.5-flash-lite");
    expect(models.map((m) => m.id)).toContain("gemini:gemini-2.5-pro");
  });

  it("retrieves a model definition by ModelId (§PR21.6.6)", async () => {
    const adapter = new GeminiAdapter();
    const model = await adapter.getModel(asModelId("gemini:gemini-2.5-flash"));

    expect(model).toBeDefined();
    expect(model?.displayName).toBe("Gemini 2.5 Flash");
    expect(model?.contextWindow).toBe(1048576);

    const unknown = await adapter.getModel(asModelId("gemini:nonexistent"));
    expect(unknown).toBeUndefined();
  });

  it("checks capabilities accurately via supports() (§PR21.6.8)", () => {
    const adapter = new GeminiAdapter();

    expect(adapter.supports(asModelId("gemini:gemini-2.5-flash"), "thinking")).toBe(true);
    expect(adapter.supports(asModelId("gemini:gemini-2.5-flash-lite"), "thinking")).toBe(false);
    expect(adapter.supports(asModelId("gemini:gemini-2.5-pro"), "thinking")).toBe(true);
    expect(adapter.supports(asModelId("gemini:gemini-2.5-flash"), "vision")).toBe(true);
    expect(adapter.supports(asModelId("gemini:nonexistent"), "text_generation")).toBe(false);
  });

  it("initializes successfully with a valid configuration (§PR21.6.4)", async () => {
    const adapter = new GeminiAdapter();

    await expect(
      adapter.initialize({
        providerId: GEMINI_PROVIDER_ID,
        credentialRef: "app/provider/gemini/key",
        defaultModelId: "gemini:gemini-2.5-flash",
      }),
    ).resolves.not.toThrow();

    expect(adapter.client).toBeDefined();
  });

  it("rejects invalid configuration with ProviderConfigError (§PR21.6.4)", async () => {
    const adapter = new GeminiAdapter();

    await expect(
      adapter.initialize({
        providerId: "wrong-provider" as unknown as ProviderId,
      }),
    ).rejects.toThrow(ProviderConfigError);

    await expect(
      adapter.initialize({
        providerId: GEMINI_PROVIDER_ID,
        credentialRef: "AIzaSyFakeKey123", // Raw key instead of reference
      }),
    ).rejects.toThrow(/raw API key/);
  });

  it("throws ModelNotFoundError when requesting an unknown model (§PR21.6.9)", async () => {
    const adapter = new GeminiAdapter();
    await adapter.initialize({
      providerId: GEMINI_PROVIDER_ID,
      credentialRef: "app/provider/gemini/key",
    });

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: asModelId("gemini:unknown-model"),
      messages: [{ role: "user", content: [textPart("Hi")] }],
    };

    const iter = adapter.chat(request)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(ModelNotFoundError);
  });

  it("invokes native streaming API and translates chunks into canonical AIEvents (§PR21.6.9)", async () => {
    const mockResponses: GenerateContentResponse[] = [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] } }],
      } as unknown as GenerateContentResponse,
      {
        candidates: [{ content: { role: "model", parts: [{ text: "world!" }] } }],
      } as unknown as GenerateContentResponse,
      {
        candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [] } }],
        usageMetadata: { totalTokenCount: 12 },
      } as unknown as GenerateContentResponse,
    ];

    let capturedParams: GenerateContentParameters | null = null;

    const mockClient = {
      models: {
        generateContentStream: async (params: GenerateContentParameters) => {
          capturedParams = params;
          return (async function* () {
            for (const r of mockResponses) {
              yield r;
            }
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiAdapter({ client: mockClient });

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: asModelId("gemini:gemini-2.5-flash"),
      messages: [{ role: "user", content: [textPart("Greeting")] }],
    };

    const events: AIEvent[] = [];
    for await (const event of adapter.chat(request)) {
      events.push(event);
    }

    // 1. Captured params used native Google model name (§PR21.6.9)
    expect(capturedParams!.model).toBe("gemini-2.5-flash");

    // 2. Canonical events translated
    expect(events.map((e) => e.type)).toEqual([
      "message.started",
      "message.delta",
      "message.delta",
      "message.completed",
    ]);

    expect((events[3] as MessageCompletedEvent).totalTokens).toBe(12);
  });

  it("forwards AbortSignal and handles cooperative cancellation cleanly (§PR21.6.10)", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const mockClient = {
      models: {
        generateContentStream: async (params: GenerateContentParameters) => {
          capturedSignal = params.config?.abortSignal;
          return (async function* () {
            yield {
              candidates: [{ content: { role: "model", parts: [{ text: "Chunk 1" }] } }],
            } as unknown as GenerateContentResponse;
            // Abort while generator is yielding
            controller.abort();
            yield {
              candidates: [{ content: { role: "model", parts: [{ text: "Chunk 2" }] } }],
            } as unknown as GenerateContentResponse;
          })();
        },
      },
    } as unknown as GoogleGenAI;

    const adapter = new GeminiAdapter({ client: mockClient });

    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: asModelId("gemini:gemini-2.5-flash"),
      messages: [{ role: "user", content: [textPart("Cancel check")] }],
    };

    const events: AIEvent[] = [];
    for await (const event of adapter.chat(request, controller.signal)) {
      events.push(event);
    }

    // AbortSignal forwarded to native config
    expect(capturedSignal).toBe(controller.signal);

    // Emits message.cancelled and terminates (§PR21.6.10)
    expect(events.some((e) => e.type === "message.cancelled")).toBe(true);
    expect(events.some((e) => e.type === "message.completed")).toBe(false);
  });

  // Opt-in live smoke test (§PR21.9 Step 24)
  it.skipIf(!process.env.RUN_GEMINI_SMOKE)(
    "opt-in live Gemini streaming smoke test (RUN_GEMINI_SMOKE=1) (§PR21.9)",
    async () => {
      const adapter = new GeminiAdapter();
      await adapter.initialize({
        providerId: GEMINI_PROVIDER_ID,
        credentialRef: "app/provider/gemini/api-key",
      });

      const request: ChatRequest = {
        conversationId: createConversationId(),
        modelId: asModelId("gemini:gemini-2.5-flash"),
        messages: [{ role: "user", content: [textPart("Respond with 'OK' only")] }],
      };

      const events: AIEvent[] = [];
      for await (const event of adapter.chat(request)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThanOrEqual(3);
      expect(events[0].type).toBe("message.started");
      expect(events[events.length - 1].type).toBe("message.completed");
    },
  );
});
