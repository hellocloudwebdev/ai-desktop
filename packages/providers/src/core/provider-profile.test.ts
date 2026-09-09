import { describe, expect, it } from "vitest";
import { generateUlid } from "@ai-desktop/shared";
import { asModelId, asProviderId } from "@ai-desktop/ai-core";
import {
  ProviderRegistry,
  AnthropicAdapter,
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  GeminiAdapter,
  GEMINI_MODELS,
  GEMINI_PROVIDER_ID,
  validateModelSelection,
  validateProviderProfile,
  ModelSelectionError,
  type ProviderProfile,
} from "../index.js";

function setupRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerProvider({
    providerId: ANTHROPIC_PROVIDER_ID,
    adapter: new AnthropicAdapter(),
  });
  for (const model of ANTHROPIC_MODELS) {
    registry.registerModel({ model });
  }

  registry.registerProvider({
    providerId: GEMINI_PROVIDER_ID,
    adapter: new GeminiAdapter(),
  });
  for (const model of GEMINI_MODELS) {
    registry.registerModel({ model });
  }
  return registry;
}

describe("PR22: ModelSelection Validation", () => {
  const registry = setupRegistry();

  it("accepts valid provider and model selection matching ownership", () => {
    const validSelection = {
      providerId: asProviderId("gemini"),
      modelId: asModelId("gemini:gemini-2.5-flash"),
    };

    const result = validateModelSelection(validSelection, registry);
    expect(result).toEqual(validSelection);
  });

  it("accepts valid Anthropic selection", () => {
    const validSelection = {
      providerId: asProviderId("anthropic"),
      modelId: ANTHROPIC_MODELS[0].id,
    };

    const result = validateModelSelection(validSelection, registry);
    expect(result).toEqual(validSelection);
  });

  it("throws ModelSelectionError for unregistered provider", () => {
    expect(() =>
      validateModelSelection(
        {
          providerId: asProviderId("unregistered-provider"),
          modelId: asModelId("gemini:gemini-2.5-flash"),
        },
        registry,
      ),
    ).toThrow(ModelSelectionError);
  });

  it("throws ModelSelectionError for unregistered model", () => {
    expect(() =>
      validateModelSelection(
        {
          providerId: asProviderId("gemini"),
          modelId: asModelId("gemini:nonexistent-model"),
        },
        registry,
      ),
    ).toThrow(ModelSelectionError);
  });

  it("throws ModelSelectionError when model provider does not match selection provider", () => {
    // Model belongs to gemini, but selection says anthropic
    expect(() =>
      validateModelSelection(
        {
          providerId: asProviderId("anthropic"),
          modelId: asModelId("gemini:gemini-2.5-flash"),
        },
        registry,
      ),
    ).toThrow(ModelSelectionError);
  });
});

describe("PR22: ProviderProfile Validation", () => {
  const registry = setupRegistry();

  it("validates a complete, valid provider profile", () => {
    const profile: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("gemini"),
      name: "Personal Gemini",
      credentialRef: "app/provider/gemini/api-key",
      endpointUrl: "https://generativelanguage.googleapis.com",
      defaultModelId: asModelId("gemini:gemini-2.5-flash"),
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = validateProviderProfile(profile, registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Personal Gemini");
    }
  });

  it("rejects profile with empty or whitespace name", () => {
    const profile: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("gemini"),
      name: "   ",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = validateProviderProfile(profile, registry);
    expect(result.ok).toBe(false);
  });

  it("rejects profile with unregistered providerId", () => {
    const profile: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("unknown-vendor"),
      name: "Unknown Profile",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = validateProviderProfile(profile, registry);
    expect(result.ok).toBe(false);
  });

  it("rejects profile with defaultModelId belonging to a different provider", () => {
    const profile: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("anthropic"),
      name: "Conflicted Profile",
      defaultModelId: asModelId("gemini:gemini-2.5-flash"), // Gemini model on Anthropic profile!
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = validateProviderProfile(profile, registry);
    expect(result.ok).toBe(false);
  });

  it("rejects profile with raw API key in credentialRef (security check)", () => {
    const profileWithAnthropicKey: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("anthropic"),
      name: "Leaked Key Profile",
      credentialRef: "sk-ant-api03-1234567890123456789012345678901234567890",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result1 = validateProviderProfile(profileWithAnthropicKey, registry);
    expect(result1.ok).toBe(false);

    const profileWithGeminiKey: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("gemini"),
      name: "Leaked Gemini Key",
      credentialRef: "AIzaSyD-123456789012345678901234567890",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result2 = validateProviderProfile(profileWithGeminiKey, registry);
    expect(result2.ok).toBe(false);
  });

  it("rejects profile with raw Bearer token in credentialRef", () => {
    const profile: ProviderProfile = {
      id: generateUlid(),
      providerId: asProviderId("gemini"),
      name: "Bearer Token Profile",
      credentialRef: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = validateProviderProfile(profile, registry);
    expect(result.ok).toBe(false);
  });
});
