// PR19: packages/providers — Provider Registry & Model Catalog Foundation
//
// Invariants (Step 41 / Phase 2):
//   1. Provider and Model are separate concepts (Provider = service/adapter, ModelDefinition = model + capabilities).
//   2. ModelDefinition owns capabilities (capabilities belong exclusively to the model, not the provider).
//   3. Duplicate provider or model registrations are strictly rejected with an Error.
//   4. A model cannot be registered without its owning provider already registered.
//   5. Unknown provider/model lookups return undefined.
//   6. Provider SDK types never escape into the registry.
//   7. No persistence, no SQLite, no network calls — pure in-memory runtime registry.

import { err, type Result } from "@ai-desktop/shared";
import type { ModelDefinition, ModelId, ProviderId } from "@ai-desktop/ai-core";
import type { ProviderAdapter } from "../core/provider-adapter.js";
import type { ProviderConfig } from "../core/provider-config.js";
import { ProviderConfigError } from "../core/provider-errors.js";
import { validateProviderConfig } from "../core/provider-config-validator.js";

export interface ProviderRegistration {
  readonly providerId: ProviderId;
  readonly adapter: ProviderAdapter;
}

export interface ModelRegistration {
  readonly model: ModelDefinition;
}

export class ProviderRegistry {
  private readonly _providers = new Map<ProviderId, ProviderRegistration>();
  private readonly _models = new Map<ModelId, ModelRegistration>();

  /**
   * Registers a provider adapter.
   * Throws if the providerId is already registered.
   */
  registerProvider(registration: ProviderRegistration): void {
    if (this._providers.has(registration.providerId)) {
      throw new Error(`Provider already registered: ${registration.providerId}`);
    }

    this._providers.set(registration.providerId, registration);
  }

  /**
   * Registers a canonical model definition.
   * Throws if the model id is already registered or if the owning provider is not registered.
   */
  registerModel(registration: ModelRegistration): void {
    const { model } = registration;

    if (this._models.has(model.id)) {
      throw new Error(`Model already registered: ${model.id}`);
    }

    if (!this._providers.has(model.providerId)) {
      throw new Error(
        `Cannot register model "${model.id}": provider "${model.providerId}" is not registered`,
      );
    }

    this._models.set(model.id, registration);
  }

  /**
   * Retrieves a registered provider by ProviderId.
   */
  getProvider(providerId: ProviderId): ProviderRegistration | undefined {
    return this._providers.get(providerId);
  }

  /**
   * Retrieves a registered model definition by ModelId.
   */
  getModel(modelId: ModelId): ModelDefinition | undefined {
    return this._models.get(modelId)?.model;
  }

  /**
   * Lists all registered providers.
   */
  listProviders(): readonly ProviderRegistration[] {
    return [...this._providers.values()];
  }

  /**
   * Lists all registered models across all providers.
   */
  listModels(): readonly ModelDefinition[] {
    return [...this._models.values()].map(({ model }) => model);
  }

  /**
   * Lists all registered models belonging to a specific provider.
   */
  listModelsForProvider(providerId: ProviderId): readonly ModelDefinition[] {
    return [...this._models.values()]
      .map(({ model }) => model)
      .filter((model) => model.providerId === providerId);
  }

  /**
   * Checks whether a provider is registered.
   */
  hasProvider(providerId: ProviderId): boolean {
    return this._providers.has(providerId);
  }

  /**
   * Checks whether a model is registered.
   */
  hasModel(modelId: ModelId): boolean {
    return this._models.has(modelId);
  }

  /**
   * Validates a provider configuration against its registered adapter.
   */
  validateConfig(config: unknown): Result<ProviderConfig, ProviderConfigError> {
    if (!config || typeof config !== "object") {
      return err(new ProviderConfigError("Configuration must be a non-null object"));
    }

    const providerId = (config as { providerId?: ProviderId })?.providerId;
    if (!providerId) {
      return err(new ProviderConfigError("Configuration must specify a providerId"));
    }

    const registration = this.getProvider(providerId);
    if (!registration) {
      return err(
        new ProviderConfigError(
          `Cannot validate configuration: provider "${providerId}" is not registered`,
          { providerId },
        ),
      );
    }

    return validateProviderConfig(config, registration.adapter);
  }

  /**
   * Clears all registered providers and models (primarily for test cleanup).
   */
  clear(): void {
    this._models.clear();
    this._providers.clear();
  }

  /**
   * Returns total count of registered providers.
   */
  get providerCount(): number {
    return this._providers.size;
  }

  /**
   * Returns total count of registered models.
   */
  get modelCount(): number {
    return this._models.size;
  }
}
