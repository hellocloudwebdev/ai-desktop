// PR11: packages/providers — Public API Surface
//
// Canonical provider contracts and the concrete AnthropicAdapter.
// Provider SDK types never escape this package boundary.

export type { ProviderAdapter } from "./core/provider-adapter.js";
export type { ProviderConfig } from "./core/provider-config.js";
export { ProviderConfigSchema } from "./core/provider-config.js";
export {
  ProviderError,
  ProviderConfigError,
  UnsupportedCapabilityError,
  ModelNotFoundError,
  ProviderRequestError,
} from "./core/provider-errors.js";

// Provider configuration validation (PR20)
export type { ProviderConfigValidator } from "./core/provider-config-validator.js";
export {
  DefaultProviderConfigValidator,
  providerConfigValidator,
  validateProviderConfig,
} from "./core/provider-config-validator.js";

// Anthropic provider implementation
export type { AnthropicAdapterOptions } from "./anthropic/anthropic-adapter.js";
export { AnthropicAdapter } from "./anthropic/anthropic-adapter.js";
export {
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_MAP,
} from "./anthropic/anthropic-models.js";
export { translateChatRequest } from "./anthropic/translate-request.js";
export { translateAnthropicStream } from "./anthropic/translate-stream.js";
export { translateAnthropicError } from "./anthropic/translate-error.js";

// Provider registry and model catalog (PR19)
export * from "./registry/index.js";
