// PR10: packages/providers — Public API Surface
//
// Canonical provider contracts and domain errors.
// Concrete provider implementations (Anthropic in PR11) reside in subdirectories.
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
