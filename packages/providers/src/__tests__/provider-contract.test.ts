// PR10: packages/providers — Provider Contract Unit Tests
//
// Tests the ProviderAdapter CONTRACT (Section 33.29–33.36) using a fake provider
// implementation. No API keys or external network requests are required.

import { describe, expect, it } from "vitest";
import {
  ok,
  err,
  type Result,
  createConversationId,
  createMessageId,
  now,
} from "@ai-desktop/shared";
import {
  asModelId,
  asProviderId,
  createEventId,
  textPart,
  type AIEvent,
  type ChatRequest,
  type MessageCompletedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type ModelCapability,
  type ModelDefinition,
  type ModelId,
} from "@ai-desktop/ai-core";
import type { ProviderAdapter } from "../core/provider-adapter.js";
import type { ProviderConfig } from "../core/provider-config.js";
import {
  ModelNotFoundError,
  ProviderConfigError,
  UnsupportedCapabilityError,
} from "../core/provider-errors.js";

const FAKE_MODEL_ID = asModelId("fake-model-1");
const FAKE_VISION_MODEL_ID = asModelId("fake-model-vision");
const FAKE_PROVIDER_ID = asProviderId("fake-provider");

const FAKE_MODELS: readonly ModelDefinition[] = [
  {
    id: FAKE_MODEL_ID,
    providerId: FAKE_PROVIDER_ID,
    displayName: "Fake Model Standard",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: ["text_generation", "streaming", "tool_use"],
  },
  {
    id: FAKE_VISION_MODEL_ID,
    providerId: FAKE_PROVIDER_ID,
    displayName: "Fake Model Vision",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: ["text_generation", "streaming", "vision", "thinking"],
  },
];

/**
 * Fake provider adapter implementing the exact ProviderAdapter contract
 * for generic contract verification without third-party SDK dependencies.
 */
class FakeProviderAdapter implements ProviderAdapter {
  readonly providerId = FAKE_PROVIDER_ID;
  private _config?: ProviderConfig;
  private _models = new Map<ModelId, ModelDefinition>(FAKE_MODELS.map((m) => [m.id, m]));

  async initialize(config: ProviderConfig): Promise<void> {
    const valid = this.validateConfig(config);
    if (!valid.ok) {
      throw valid.error;
    }
    this._config = config;
  }

  async listModels(): Promise<readonly ModelDefinition[]> {
    return Array.from(this._models.values());
  }

  async getModel(modelId: ModelId): Promise<ModelDefinition | undefined> {
    return this._models.get(modelId);
  }

  validateConfig(config: ProviderConfig): Result<void, ProviderConfigError> {
    if (!config.providerId) {
      return err(
        new ProviderConfigError("providerId is required", { providerId: this.providerId }),
      );
    }
    if (config.endpointUrl && !config.endpointUrl.startsWith("http")) {
      return err(
        new ProviderConfigError("endpointUrl must be a valid URL", { providerId: this.providerId }),
      );
    }
    return ok(undefined);
  }

  supports(modelId: ModelId, capability: ModelCapability): boolean {
    const model = this._models.get(modelId);
    if (!model) return false;
    return model.capabilities.includes(capability);
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
    const model = this._models.get(request.modelId);
    if (!model) {
      throw new ModelNotFoundError(request.modelId, { providerId: this.providerId });
    }

    if (signal?.aborted) {
      return;
    }

    const convId = request.conversationId;
    const msgId = createMessageId();

    const started: MessageStartedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: msgId,
      role: "assistant",
      content: [],
    };
    yield started;

    const chunks = ["Hello", " from", " fake", " provider!"];
    let seq = 1;

    for (const chunk of chunks) {
      if (signal?.aborted) {
        return;
      }
      const delta: MessageDeltaEvent = {
        eventId: createEventId(),
        conversationId: convId,
        sequence: seq++,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: msgId,
        deltaText: chunk,
      };
      yield delta;
    }

    const completed: MessageCompletedEvent = {
      eventId: createEventId(),
      conversationId: convId,
      sequence: seq++,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: msgId,
      finishReason: "stop",
    };
    yield completed;
  }
}

describe("ProviderAdapter: Contract Specification Tests", () => {
  it("initializes successfully with valid configuration", async () => {
    const adapter = new FakeProviderAdapter();
    const config: ProviderConfig = {
      providerId: FAKE_PROVIDER_ID,
      credentialRef: "app/provider/fake/api-key",
      endpointUrl: "https://api.fake.com",
    };

    await expect(adapter.initialize(config)).resolves.toBeUndefined();
  });

  it("validates configuration and returns ProviderConfigError on invalid input", () => {
    const adapter = new FakeProviderAdapter();
    const badConfig: ProviderConfig = {
      providerId: FAKE_PROVIDER_ID,
      endpointUrl: "not-a-valid-url",
    };

    const result = adapter.validateConfig(badConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ProviderConfigError);
      expect(result.error.message).toContain("endpointUrl");
    }
  });

  it("lists supported models and ensures capabilities belong to ModelDefinition", async () => {
    const adapter = new FakeProviderAdapter();
    const models = await adapter.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe(FAKE_MODEL_ID);
    expect(models[0].providerId).toBe(FAKE_PROVIDER_ID);
    // Invariant: ModelDefinition owns capabilities
    expect(models[0].capabilities).toContain("text_generation");
    expect(models[0].capabilities).toContain("tool_use");
    expect(models[0].capabilities).not.toContain("vision");
  });

  it("looks up specific models via getModel and returns undefined for missing models", async () => {
    const adapter = new FakeProviderAdapter();

    const existing = await adapter.getModel(FAKE_MODEL_ID);
    expect(existing).toBeDefined();
    expect(existing?.displayName).toBe("Fake Model Standard");

    const missing = await adapter.getModel(asModelId("non-existent-model"));
    expect(missing).toBeUndefined();
  });

  it("supports() evaluates capabilities cleanly without inspecting SDK internals", () => {
    const adapter = new FakeProviderAdapter();

    expect(adapter.supports(FAKE_MODEL_ID, "text_generation")).toBe(true);
    expect(adapter.supports(FAKE_MODEL_ID, "tool_use")).toBe(true);
    expect(adapter.supports(FAKE_MODEL_ID, "vision")).toBe(false);

    expect(adapter.supports(FAKE_VISION_MODEL_ID, "vision")).toBe(true);
    expect(adapter.supports(FAKE_VISION_MODEL_ID, "thinking")).toBe(true);
    expect(adapter.supports(FAKE_VISION_MODEL_ID, "tool_use")).toBe(false);
  });

  it("streams canonical AIEvents from chat()", async () => {
    const adapter = new FakeProviderAdapter();
    const convId = createConversationId();

    const request: ChatRequest = {
      conversationId: convId,
      modelId: FAKE_MODEL_ID,
      messages: [{ role: "user", content: [textPart("Say hello")] }],
    };

    const events: AIEvent[] = [];
    for await (const event of adapter.chat(request)) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe("message.started");
    expect(events[events.length - 1].type).toBe("message.completed");

    const deltas = events.filter((e) => e.type === "message.delta") as MessageDeltaEvent[];
    const fullText = deltas.map((d) => d.deltaText).join("");
    expect(fullText).toBe("Hello from fake provider!");
  });

  it("observes AbortSignal cancellation and terminates event stream", async () => {
    const adapter = new FakeProviderAdapter();
    const controller = new AbortController();
    const convId = createConversationId();

    const request: ChatRequest = {
      conversationId: convId,
      modelId: FAKE_MODEL_ID,
      messages: [{ role: "user", content: [textPart("Cancel me")] }],
    };

    // Pre-aborted signal
    controller.abort();

    const events: AIEvent[] = [];
    for await (const event of adapter.chat(request, controller.signal)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it("throws ModelNotFoundError when requested model does not exist", async () => {
    const adapter = new FakeProviderAdapter();
    const request: ChatRequest = {
      conversationId: createConversationId(),
      modelId: asModelId("unknown-model-xyz"),
      messages: [{ role: "user", content: [textPart("Hello")] }],
    };

    const stream = adapter.chat(request);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(ModelNotFoundError);
  });

  it("proves UnsupportedCapabilityError can be constructed and carries capability metadata", () => {
    const err = new UnsupportedCapabilityError("vision", undefined, {
      providerId: FAKE_PROVIDER_ID,
      modelId: FAKE_MODEL_ID,
    });
    expect(err.code).toBe("UNSUPPORTED_CAPABILITY_ERROR");
    expect(err.capability).toBe("vision");
    expect(err.modelId).toBe(FAKE_MODEL_ID);
    expect(err.message).toContain("vision");
  });
});
