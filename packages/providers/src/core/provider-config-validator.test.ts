import { describe, expect, it } from "vitest";
import {
  asProviderId,
  type ModelDefinition,
  type ModelId,
  type ProviderId,
} from "@ai-desktop/ai-core";
import { ok, type Result } from "@ai-desktop/shared";
import type { ProviderAdapter } from "./provider-adapter.js";
import { ProviderConfigSchema, type ProviderConfig } from "./provider-config.js";
import { ProviderConfigError } from "./provider-errors.js";
import { validateProviderConfig } from "./provider-config-validator.js";
import { ANTHROPIC_MODELS, ANTHROPIC_PROVIDER_ID } from "../anthropic/anthropic-models.js";
import { AnthropicAdapter } from "../anthropic/anthropic-adapter.js";
import { ProviderRegistry } from "../registry/provider-registry.js";

class TestAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: ProviderId = asProviderId("test-provider"),
    private readonly _supportedModels = new Set<string>(["model-a", "model-b"]),
  ) {}

  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return [];
  }
  async getModel(modelId: ModelId): Promise<ModelDefinition | undefined> {
    if (this._supportedModels.has(modelId)) {
      return {
        id: modelId,
        providerId: this.providerId,
        displayName: String(modelId),
        contextWindow: 100000,
        capabilities: ["text_generation"],
      };
    }
    return undefined;
  }
  validateConfig(config: ProviderConfig): Result<void, ProviderConfigError> {
    if (config.providerId !== this.providerId) {
      return {
        ok: false,
        error: new ProviderConfigError("Provider ID mismatch", { providerId: this.providerId }),
      };
    }
    if (config.defaultModelId && !this._supportedModels.has(config.defaultModelId)) {
      return {
        ok: false,
        error: new ProviderConfigError(
          `Model "${config.defaultModelId}" is not supported by this adapter`,
          { providerId: this.providerId },
        ),
      };
    }
    return ok(undefined);
  }
  supports(): boolean {
    return true;
  }
  async *chat() {}
}

describe("packages/providers: ProviderConfigValidator & Configuration Validation (PR20)", () => {
  it("structurally valid config succeeds and returns canonical Result.ok", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"));
    const config = {
      providerId: "my-provider",
      credentialRef: "secret://keys/my-key",
      endpointUrl: "https://api.myprovider.com/v1",
      timeoutMs: 5000,
    };

    const res = validateProviderConfig(config, adapter);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.providerId).toBe("my-provider");
      expect(res.value.credentialRef).toBe("secret://keys/my-key");
      expect(res.value.timeoutMs).toBe(5000);
    }
  });

  it("malformed config becomes canonical ProviderConfigError (no raw Zod error escapes)", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"));

    // Missing providerId
    const res = validateProviderConfig({ timeoutMs: 1000 }, adapter);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ProviderConfigError);
      expect(res.error.code).toBe("PROVIDER_CONFIG_ERROR");
      expect(res.error.message).toContain("providerId");
    }
  });

  it("missing or empty credential reference is handled correctly", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"));

    // 1. undefined credentialRef is structurally allowed (optional field)
    const validNoCreds = validateProviderConfig({ providerId: "my-provider" }, adapter);
    expect(validNoCreds.ok).toBe(true);

    // 2. empty string credentialRef is rejected
    const emptyCreds = validateProviderConfig(
      { providerId: "my-provider", credentialRef: "" },
      adapter,
    );
    expect(emptyCreds.ok).toBe(false);
    if (!emptyCreds.ok) {
      expect(emptyCreds.error).toBeInstanceOf(ProviderConfigError);
      expect(emptyCreds.error.message).toContain("credentialRef");
    }

    // 3. whitespace-only credentialRef is rejected
    const whitespaceCreds = validateProviderConfig(
      { providerId: "my-provider", credentialRef: "   " },
      adapter,
    );
    expect(whitespaceCreds.ok).toBe(false);
    if (!whitespaceCreds.ok) {
      expect(whitespaceCreds.error).toBeInstanceOf(ProviderConfigError);
    }
  });

  it("provider ID mismatch fails with ProviderConfigError (§Step 5)", () => {
    const adapter = new TestAdapter(asProviderId("anthropic"));
    const config = {
      providerId: "openai",
      credentialRef: "app/provider/openai/key",
    };

    const res = validateProviderConfig(config, adapter);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ProviderConfigError);
      expect(res.error.message).toContain("Provider ID mismatch");
      expect(res.error.message).toContain("openai");
      expect(res.error.message).toContain("anthropic");
    }
  });

  it("invalid endpoint URL fails with ProviderConfigError", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"));

    const res = validateProviderConfig(
      {
        providerId: "my-provider",
        endpointUrl: "not-a-valid-url",
      },
      adapter,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ProviderConfigError);
      expect(res.error.message).toContain("endpointUrl");
    }
  });

  it("timeout validation is deterministic (§Step 7)", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"));

    // Valid timeouts
    expect(validateProviderConfig({ providerId: "my-provider" }, adapter).ok).toBe(true);
    expect(validateProviderConfig({ providerId: "my-provider", timeoutMs: 1 }, adapter).ok).toBe(
      true,
    );
    expect(
      validateProviderConfig({ providerId: "my-provider", timeoutMs: 30000 }, adapter).ok,
    ).toBe(true);

    // Invalid timeouts
    const invalidValues = [0, -1, 1.5, NaN, Infinity, -Infinity];
    for (const val of invalidValues) {
      const res = validateProviderConfig({ providerId: "my-provider", timeoutMs: val }, adapter);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(ProviderConfigError);
      }
    }
  });

  it("raw secrets are strictly rejected by the canonical config schema (§Step 8)", () => {
    const forbiddenPayloads = [
      { providerId: "anthropic", apiKey: "sk-ant-api03-secret123" },
      { providerId: "anthropic", accessToken: "ya29.secret" },
      { providerId: "anthropic", refreshToken: "1//secret" },
      { providerId: "anthropic", password: "mypassword" },
      { providerId: "anthropic", secret: "supersecret" },
    ];

    for (const payload of forbiddenPayloads) {
      const parseRes = ProviderConfigSchema.safeParse(payload);
      expect(parseRes.success).toBe(false);

      const adapter = new TestAdapter(asProviderId("anthropic"));
      const validateRes = validateProviderConfig(payload, adapter);
      expect(validateRes.ok).toBe(false);
      if (!validateRes.ok) {
        expect(validateRes.error.message).toContain("Raw credentials");
      }
    }
  });

  it("delegates model availability check to adapter semantics (§Step 6)", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"), new Set(["model-a"]));

    // Supported model succeeds
    const okRes = validateProviderConfig(
      { providerId: "my-provider", defaultModelId: "model-a" },
      adapter,
    );
    expect(okRes.ok).toBe(true);

    // Unsupported model fails with adapter error
    const failRes = validateProviderConfig(
      { providerId: "my-provider", defaultModelId: "model-nonexistent" },
      adapter,
    );
    expect(failRes.ok).toBe(false);
    if (!failRes.ok) {
      expect(failRes.error).toBeInstanceOf(ProviderConfigError);
      expect(failRes.error.message).toContain("not supported");
    }
  });

  it("performs no network calls during validation", () => {
    const adapter = new TestAdapter(asProviderId("my-provider"));
    const config = {
      providerId: "my-provider",
      endpointUrl: "https://unreachable-domain-123456789.org/v1",
    };

    // Must be completely synchronous and offline
    const res = validateProviderConfig(config, adapter);
    expect(res.ok).toBe(true);
  });
});

describe("packages/providers: ProviderRegistry validateConfig Integration", () => {
  it("validates registered provider configuration through ProviderRegistry", () => {
    const registry = new ProviderRegistry();
    const adapter = new TestAdapter(asProviderId("prov-1"), new Set(["m-1"]));

    registry.registerProvider({ providerId: adapter.providerId, adapter });

    // Valid config through registry
    const resOk = registry.validateConfig({
      providerId: "prov-1",
      defaultModelId: "m-1",
    });
    expect(resOk.ok).toBe(true);

    // Unsupported model through registry
    const resBadModel = registry.validateConfig({
      providerId: "prov-1",
      defaultModelId: "m-unsupported",
    });
    expect(resBadModel.ok).toBe(false);
    if (!resBadModel.ok) {
      expect(resBadModel.error).toBeInstanceOf(ProviderConfigError);
    }

    // Unregistered provider through registry
    const resUnregistered = registry.validateConfig({
      providerId: "prov-unregistered",
    });
    expect(resUnregistered.ok).toBe(false);
    if (!resUnregistered.ok) {
      expect(resUnregistered.error).toBeInstanceOf(ProviderConfigError);
      expect(resUnregistered.error.message).toContain("not registered");
    }
  });
});

describe("packages/providers: AnthropicAdapter.validateConfig Strengthening (§Step 9)", () => {
  it("validates Anthropic-specific configuration correctly without network calls", () => {
    const adapter = new AnthropicAdapter();

    // 1. Valid Anthropic configuration
    const resOk = adapter.validateConfig({
      providerId: ANTHROPIC_PROVIDER_ID,
      credentialRef: "app/provider/anthropic/key",
      defaultModelId: ANTHROPIC_MODELS[0].id,
      timeoutMs: 60000,
    });
    expect(resOk.ok).toBe(true);

    // 2. Reject raw Anthropic API key passed as credentialRef (§Step 8, Step 9)
    const resRawKey = adapter.validateConfig({
      providerId: ANTHROPIC_PROVIDER_ID,
      credentialRef: "sk-ant-api03-live-token",
    });
    expect(resRawKey.ok).toBe(false);
    if (!resRawKey.ok) {
      expect(resRawKey.error).toBeInstanceOf(ProviderConfigError);
      expect(resRawKey.error.message).toContain("raw API key");
    }

    // 3. Reject unsupported model for Anthropic
    const resBadModel = adapter.validateConfig({
      providerId: ANTHROPIC_PROVIDER_ID,
      defaultModelId: "gpt-4o",
    });
    expect(resBadModel.ok).toBe(false);
    if (!resBadModel.ok) {
      expect(resBadModel.error).toBeInstanceOf(ProviderConfigError);
      expect(resBadModel.error.message).toContain("Unsupported default model");
    }

    // 4. Reject non-HTTP endpointUrl
    const resBadUrl = adapter.validateConfig({
      providerId: ANTHROPIC_PROVIDER_ID,
      endpointUrl: "ftp://files.anthropic.com",
    });
    expect(resBadUrl.ok).toBe(false);
    if (!resBadUrl.ok) {
      expect(resBadUrl.error).toBeInstanceOf(ProviderConfigError);
      expect(resBadUrl.error.message).toContain("HTTP or HTTPS");
    }
  });
});
