import { describe, expect, it } from "vitest";
import { asModelId, asProviderId, type ModelDefinition } from "@ai-desktop/ai-core";
import { ok, type Result } from "@ai-desktop/shared";
import type { ProviderAdapter } from "../core/provider-adapter.js";
import type { ProviderConfigError } from "../core/provider-errors.js";
import { ANTHROPIC_MODELS, ANTHROPIC_PROVIDER_ID } from "../anthropic/anthropic-models.js";
import { ProviderRegistry } from "./provider-registry.js";

class DummyAdapter implements ProviderAdapter {
  constructor(readonly providerId = asProviderId("dummy-provider")) {}
  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return [];
  }
  async getModel(): Promise<ModelDefinition | undefined> {
    return undefined;
  }
  validateConfig(): Result<void, ProviderConfigError> {
    return ok(undefined);
  }
  supports(): boolean {
    return true;
  }
  async *chat() {}
}

describe("packages/providers: ProviderRegistry & Model Catalog (PR19)", () => {
  it("registers a provider", () => {
    const registry = new ProviderRegistry();
    const adapter = new DummyAdapter(asProviderId("provider-a"));

    registry.registerProvider({
      providerId: adapter.providerId,
      adapter,
    });

    expect(registry.hasProvider(adapter.providerId)).toBe(true);
    expect(registry.providerCount).toBe(1);
    expect(registry.getProvider(adapter.providerId)?.adapter).toBe(adapter);
  });

  it("rejects duplicate provider IDs with a descriptive error", () => {
    const registry = new ProviderRegistry();
    const adapter1 = new DummyAdapter(asProviderId("provider-a"));
    const adapter2 = new DummyAdapter(asProviderId("provider-a"));

    registry.registerProvider({ providerId: adapter1.providerId, adapter: adapter1 });

    expect(() =>
      registry.registerProvider({ providerId: adapter2.providerId, adapter: adapter2 }),
    ).toThrow("Provider already registered: provider-a");
  });

  it("registers a model under an existing provider", () => {
    const registry = new ProviderRegistry();
    const providerId = asProviderId("provider-a");
    const adapter = new DummyAdapter(providerId);

    registry.registerProvider({ providerId, adapter });

    const model: ModelDefinition = {
      id: asModelId("model-1"),
      providerId,
      displayName: "Model 1",
      contextWindow: 128000,
      capabilities: ["text_generation", "streaming"],
    };

    registry.registerModel({ model });

    expect(registry.hasModel(model.id)).toBe(true);
    expect(registry.modelCount).toBe(1);
    expect(registry.getModel(model.id)).toEqual(model);
  });

  it("rejects duplicate model IDs with a descriptive error", () => {
    const registry = new ProviderRegistry();
    const providerId = asProviderId("provider-a");
    registry.registerProvider({ providerId, adapter: new DummyAdapter(providerId) });

    const model: ModelDefinition = {
      id: asModelId("model-1"),
      providerId,
      displayName: "Model 1",
      contextWindow: 128000,
      capabilities: ["text_generation"],
    };

    registry.registerModel({ model });

    expect(() => registry.registerModel({ model })).toThrow("Model already registered: model-1");
  });

  it("rejects a model whose provider is unknown", () => {
    const registry = new ProviderRegistry();

    const model: ModelDefinition = {
      id: asModelId("model-orphan"),
      providerId: asProviderId("unregistered-provider"),
      displayName: "Orphan Model",
      contextWindow: 64000,
      capabilities: ["text_generation"],
    };

    expect(() => registry.registerModel({ model })).toThrow(
      'Cannot register model "model-orphan": provider "unregistered-provider" is not registered',
    );
  });

  it("returns undefined when retrieving unknown provider or model", () => {
    const registry = new ProviderRegistry();

    expect(registry.getProvider(asProviderId("unknown"))).toBeUndefined();
    expect(registry.getModel(asModelId("unknown"))).toBeUndefined();
    expect(registry.hasProvider(asProviderId("unknown"))).toBe(false);
    expect(registry.hasModel(asModelId("unknown"))).toBe(false);
  });

  it("lists all registered providers and models", () => {
    const registry = new ProviderRegistry();
    const p1 = asProviderId("p1");
    const p2 = asProviderId("p2");

    registry.registerProvider({ providerId: p1, adapter: new DummyAdapter(p1) });
    registry.registerProvider({ providerId: p2, adapter: new DummyAdapter(p2) });

    const m1: ModelDefinition = {
      id: asModelId("m1"),
      providerId: p1,
      displayName: "M1",
      contextWindow: 1000,
      capabilities: ["text_generation"],
    };
    const m2: ModelDefinition = {
      id: asModelId("m2"),
      providerId: p2,
      displayName: "M2",
      contextWindow: 2000,
      capabilities: ["streaming"],
    };

    registry.registerModel({ model: m1 });
    registry.registerModel({ model: m2 });

    expect(registry.listProviders()).toHaveLength(2);
    expect(registry.listModels()).toHaveLength(2);
    expect(registry.listModels()).toEqual([m1, m2]);
  });

  it("lists models belonging to one specific provider", () => {
    const registry = new ProviderRegistry();
    const p1 = asProviderId("p1");
    const p2 = asProviderId("p2");

    registry.registerProvider({ providerId: p1, adapter: new DummyAdapter(p1) });
    registry.registerProvider({ providerId: p2, adapter: new DummyAdapter(p2) });

    const m1: ModelDefinition = {
      id: asModelId("m1"),
      providerId: p1,
      displayName: "M1",
      contextWindow: 1000,
      capabilities: ["text_generation"],
    };
    const m2: ModelDefinition = {
      id: asModelId("m2"),
      providerId: p1,
      displayName: "M2",
      contextWindow: 2000,
      capabilities: ["text_generation"],
    };
    const m3: ModelDefinition = {
      id: asModelId("m3"),
      providerId: p2,
      displayName: "M3",
      contextWindow: 3000,
      capabilities: ["text_generation"],
    };

    registry.registerModel({ model: m1 });
    registry.registerModel({ model: m2 });
    registry.registerModel({ model: m3 });

    const p1Models = registry.listModelsForProvider(p1);
    expect(p1Models).toEqual([m1, m2]);

    const p2Models = registry.listModelsForProvider(p2);
    expect(p2Models).toEqual([m3]);

    const unknownModels = registry.listModelsForProvider(asProviderId("unknown"));
    expect(unknownModels).toEqual([]);
  });

  it("registers canonical Anthropic models without changing their definitions", () => {
    const registry = new ProviderRegistry();
    const adapter = new DummyAdapter(ANTHROPIC_PROVIDER_ID);

    registry.registerProvider({
      providerId: ANTHROPIC_PROVIDER_ID,
      adapter,
    });

    for (const model of ANTHROPIC_MODELS) {
      registry.registerModel({ model });
    }

    expect(registry.listModelsForProvider(ANTHROPIC_PROVIDER_ID)).toHaveLength(
      ANTHROPIC_MODELS.length,
    );

    for (const model of ANTHROPIC_MODELS) {
      expect(registry.hasModel(model.id)).toBe(true);
      expect(registry.getModel(model.id)).toEqual(model);
      // Verify ModelDefinition owns capabilities
      expect(registry.getModel(model.id)?.capabilities).toBe(model.capabilities);
    }
  });

  it("clears all registrations cleanly via clear()", () => {
    const registry = new ProviderRegistry();
    const p1 = asProviderId("p1");
    registry.registerProvider({ providerId: p1, adapter: new DummyAdapter(p1) });
    registry.registerModel({
      model: {
        id: asModelId("m1"),
        providerId: p1,
        displayName: "M1",
        contextWindow: 1000,
        capabilities: ["text_generation"],
      },
    });

    expect(registry.providerCount).toBe(1);
    expect(registry.modelCount).toBe(1);

    registry.clear();

    expect(registry.providerCount).toBe(0);
    expect(registry.modelCount).toBe(0);
    expect(registry.listProviders()).toEqual([]);
    expect(registry.listModels()).toEqual([]);
  });
});
