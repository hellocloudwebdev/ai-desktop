// PR10: packages/providers — Canonical ProviderAdapter Contract
//
// Invariants (Step 33):
//   1. Provider and Model are separate (Provider = service/backend identity, ModelDefinition = capabilities).
//   2. ModelDefinition owns capabilities (supports(...) is capability-based).
//   3. Canonical request = ChatRequest (no Anthropic/OpenAI SDK types).
//   4. Canonical output = AsyncIterable<AIEvent> (canonical stream translation).
//   5. Cancellation uses standard AbortSignal.
//   6. Provider SDK types stay inside providers.
//   7. OpenAI-compatible APIs are not the internal abstraction.

import type { Result } from "@ai-desktop/shared";
import type {
  AIEvent,
  ChatRequest,
  ModelCapability,
  ModelDefinition,
  ModelId,
  ProviderId,
} from "@ai-desktop/ai-core";
import type { ProviderConfig } from "./provider-config.js";
import type { ProviderConfigError } from "./provider-errors.js";

export interface ProviderAdapter {
  /**
   * Semantic identifier of this provider (e.g. "anthropic", "openai").
   */
  readonly providerId: ProviderId;

  /**
   * Initializes the provider adapter with configuration.
   * Does not execute network calls or load remote state unless required by the adapter.
   */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Lists all canonical model definitions supported by this provider.
   * Model definitions own their capability declarations.
   */
  listModels(): Promise<readonly ModelDefinition[]>;

  /**
   * Retrieves a specific canonical model definition by ModelId.
   * Returns undefined if the model is not supported by this provider.
   */
  getModel(modelId: ModelId): Promise<ModelDefinition | undefined>;

  /**
   * Validates provider configuration synchronously or offline.
   * Returns Result.ok(void) on success or Result.err(ProviderConfigError).
   */
  validateConfig(config: ProviderConfig): Result<void, ProviderConfigError>;

  /**
   * Checks whether a specific model (or this provider generally) supports
   * a requested canonical capability without inspecting SDK-specific internals.
   */
  supports(modelId: ModelId, capability: ModelCapability): boolean;

  /**
   * Executes a streaming chat request, returning an AsyncIterable stream of canonical AIEvents.
   *
   * @param request Canonical, provider-neutral chat request.
   * @param signal Standard AbortSignal for idempotent cancellation.
   */
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent>;
}
