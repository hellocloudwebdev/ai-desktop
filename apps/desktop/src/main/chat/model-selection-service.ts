// PR22.7: apps/desktop — Runtime Profile & Model Selection Resolution Service
//
// Invariants:
//   1. Resolves model for a conversation in strict precedence order:
//        a. Explicitly requested modelId
//        b. Persisted conversation model selection (historical preservation)
//        c. Default model from first enabled provider profile
//        d. Global fallback default model from registry
//   2. Resolves the appropriate ProviderAdapter dynamically from ProviderRegistry.
//   3. Decoupled from vendor SDKs; uses canonical IDs exclusively.
//   4. Validates all profile mutations and model selections against the ProviderRegistry.

import { asModelId, type ModelDefinition, type ModelId } from "@ai-desktop/ai-core";
import {
  ModelNotFoundError,
  ModelSelectionError,
  validateModelSelection,
  validateProviderProfile,
  type CreateProfileInput,
  type ModelSelection,
  type ProviderAdapter,
  type ProviderProfile,
  type ProviderRegistry,
} from "@ai-desktop/providers";
import type {
  ConversationModelRepository,
  CreateProfileData,
  ProviderProfileRepository,
  StoredConversationModel,
  StoredProviderProfile,
  UpdateProfileData,
} from "@ai-desktop/storage";
import { generateUlid } from "@ai-desktop/shared";

export interface ResolvedModelRoute {
  readonly selection: ModelSelection;
  readonly model: ModelDefinition;
  readonly adapter: ProviderAdapter;
}

export interface ModelSelectionServiceOptions {
  readonly registry: ProviderRegistry;
  readonly profileRepo: ProviderProfileRepository;
  readonly conversationModelRepo: ConversationModelRepository;
  readonly defaultFallbackModelId?: ModelId;
}

export class ModelSelectionService {
  private readonly _registry: ProviderRegistry;
  private readonly _profileRepo: ProviderProfileRepository;
  private readonly _conversationModelRepo: ConversationModelRepository;
  private readonly _defaultFallbackModelId?: ModelId;

  constructor(options: ModelSelectionServiceOptions) {
    this._registry = options.registry;
    this._profileRepo = options.profileRepo;
    this._conversationModelRepo = options.conversationModelRepo;
    this._defaultFallbackModelId = options.defaultFallbackModelId;
  }

  get registry(): ProviderRegistry {
    return this._registry;
  }

  get profileRepo(): ProviderProfileRepository {
    return this._profileRepo;
  }

  get conversationModelRepo(): ConversationModelRepository {
    return this._conversationModelRepo;
  }

  /**
   * Resolves the authoritative ModelSelection and corresponding ProviderAdapter
   * for a given conversation with strict precedence order:
   *   1. Explicit request input (modelId)
   *   2. Conversation's persisted model selection
   *   3. Enabled profile's default model
   *   4. Global fallback default model from registry
   */
  async resolveForConversation(
    conversationId: string,
    requestedModelId?: string,
  ): Promise<ResolvedModelRoute> {
    // 1. Explicit model request
    if (requestedModelId) {
      const canonicalId = asModelId(requestedModelId);
      const model = this._registry.getModel(canonicalId);
      if (!model) {
        throw new ModelNotFoundError(canonicalId);
      }
      const reg = this._registry.getProvider(model.providerId);
      if (!reg) {
        throw new ModelSelectionError(
          `Provider "${model.providerId}" for model "${canonicalId}" is not registered`,
          model.providerId,
          canonicalId,
        );
      }
      return {
        selection: { providerId: model.providerId, modelId: model.id },
        model,
        adapter: reg.adapter,
      };
    }

    // 2. Persisted conversation model selection
    const persisted = await this._conversationModelRepo.getByConversationId(conversationId);
    if (persisted) {
      const canonicalId = asModelId(persisted.modelId);
      const model = this._registry.getModel(canonicalId);
      if (model) {
        const reg = this._registry.getProvider(model.providerId);
        if (reg) {
          return {
            selection: { providerId: model.providerId, modelId: model.id },
            model,
            adapter: reg.adapter,
          };
        }
      }
    }

    // 3. Enabled profile default model
    const enabledProfiles = await this._profileRepo.listEnabled();
    for (const profile of enabledProfiles) {
      if (profile.defaultModelId) {
        const canonicalId = asModelId(profile.defaultModelId);
        const model = this._registry.getModel(canonicalId);
        if (model) {
          const reg = this._registry.getProvider(model.providerId);
          if (reg) {
            return {
              selection: { providerId: model.providerId, modelId: model.id },
              model,
              adapter: reg.adapter,
            };
          }
        }
      }
    }

    // 4. Global fallback default model
    if (this._defaultFallbackModelId) {
      const model = this._registry.getModel(this._defaultFallbackModelId);
      if (model) {
        const reg = this._registry.getProvider(model.providerId);
        if (reg) {
          return {
            selection: { providerId: model.providerId, modelId: model.id },
            model,
            adapter: reg.adapter,
          };
        }
      }
    }

    // Fallback to first registered model
    const allModels = this._registry.listModels();
    if (allModels.length === 0) {
      throw new ModelSelectionError("No models are registered in ProviderRegistry");
    }

    const firstModel = allModels[0];
    const reg = this._registry.getProvider(firstModel.providerId);
    if (!reg) {
      throw new ModelSelectionError(
        `Provider "${firstModel.providerId}" for model "${firstModel.id}" is not registered`,
        firstModel.providerId,
        firstModel.id,
      );
    }

    return {
      selection: { providerId: firstModel.providerId, modelId: firstModel.id },
      model: firstModel,
      adapter: reg.adapter,
    };
  }

  /**
   * Sets the model selection for a conversation and persists it.
   */
  async setConversationModel(
    conversationId: string,
    selection: ModelSelection,
    profileId?: string,
  ): Promise<StoredConversationModel> {
    const validated = validateModelSelection(selection, this._registry);
    return this._conversationModelRepo.set({
      conversationId,
      providerId: validated.providerId,
      modelId: validated.modelId,
      profileId: profileId ?? null,
      updatedAt: Date.now(),
    });
  }

  /**
   * Retrieves the persisted model selection for a conversation.
   */
  async getConversationModel(conversationId: string): Promise<StoredConversationModel | null> {
    return this._conversationModelRepo.getByConversationId(conversationId);
  }

  /**
   * Lists all models available across all registered providers.
   */
  listAvailableModels(): readonly ModelDefinition[] {
    return this._registry.listModels();
  }

  /**
   * Lists all saved provider profiles.
   */
  async listProfiles(): Promise<StoredProviderProfile[]> {
    return this._profileRepo.listAll();
  }

  /**
   * Creates and persists a new provider profile after validating against ProviderRegistry.
   */
  async createProfile(input: CreateProfileInput): Promise<StoredProviderProfile> {
    const id = generateUlid();
    const ts = Date.now();

    const candidateProfile: ProviderProfile = {
      id,
      providerId: input.providerId,
      name: input.name,
      credentialRef: input.credentialRef,
      endpointUrl: input.endpointUrl,
      organizationId: input.organizationId,
      defaultModelId: input.defaultModelId,
      enabled: input.enabled,
      createdAt: ts,
      updatedAt: ts,
    };

    const validationResult = validateProviderProfile(candidateProfile, this._registry);
    if (!validationResult.ok) {
      throw validationResult.error;
    }

    const createData: CreateProfileData = {
      id,
      providerId: candidateProfile.providerId,
      name: candidateProfile.name,
      credentialRef: candidateProfile.credentialRef ?? null,
      endpointUrl: candidateProfile.endpointUrl ?? null,
      organizationId: candidateProfile.organizationId ?? null,
      defaultModelId: candidateProfile.defaultModelId ?? null,
      enabled: candidateProfile.enabled,
      createdAt: ts,
      updatedAt: ts,
    };

    return this._profileRepo.create(createData);
  }

  /**
   * Updates an existing provider profile.
   */
  async updateProfile(id: string, updates: UpdateProfileData): Promise<StoredProviderProfile> {
    return this._profileRepo.update(id, updates);
  }

  /**
   * Deletes a provider profile.
   */
  async deleteProfile(id: string): Promise<void> {
    return this._profileRepo.delete(id);
  }
}
