// PR23: apps/desktop/__tests__ — Reusable Test Doubles and Harness Helpers
//
// Provides in-memory test doubles for repositories and model selection
// to migrate tests to the provider-neutral ChatService contract.

import type { AIEvent, ModelDefinition, ModelId, ProviderId } from "@ai-desktop/ai-core";
import type { ConversationId } from "@ai-desktop/shared";
import { ANTHROPIC_MODELS, ProviderRegistry, type ProviderAdapter } from "@ai-desktop/providers";
import type {
  ConversationModelRepository,
  CreateProfileData,
  EventRepository,
  ProviderProfileRepository,
  SetConversationModelData,
  StoredConversationModel,
  StoredProviderProfile,
  UpdateProfileData,
} from "@ai-desktop/storage";
import { EventBus } from "@ai-desktop/agent-runtime";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { ChatService } from "../main/chat/chat-service.js";
import { ModelSelectionService } from "../main/chat/model-selection-service.js";

export class InMemoryEventRepository implements EventRepository {
  private readonly _events = new Map<ConversationId, AIEvent[]>();

  async append(event: Readonly<AIEvent>): Promise<void> {
    const list = this._events.get(event.conversationId) ?? [];
    if (list.some((e) => e.sequence === event.sequence)) {
      throw new Error(`Duplicate sequence: ${event.sequence}`);
    }
    list.push(event as AIEvent);
    this._events.set(event.conversationId, list);
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    return [...(this._events.get(conversationId) ?? [])];
  }
}

export class InMemoryProfileRepository implements ProviderProfileRepository {
  private readonly _profiles = new Map<string, StoredProviderProfile>();

  async create(data: CreateProfileData): Promise<StoredProviderProfile> {
    const profile: StoredProviderProfile = {
      id: data.id,
      providerId: data.providerId,
      name: data.name,
      credentialRef: data.credentialRef ?? null,
      endpointUrl: data.endpointUrl ?? null,
      organizationId: data.organizationId ?? null,
      defaultModelId: data.defaultModelId ?? null,
      enabled: data.enabled,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    this._profiles.set(data.id, profile);
    return profile;
  }

  async getById(id: string): Promise<StoredProviderProfile | null> {
    return this._profiles.get(id) ?? null;
  }

  async getByProviderId(providerId: ProviderId): Promise<StoredProviderProfile[]> {
    return [...this._profiles.values()].filter((p) => p.providerId === providerId);
  }

  async listAll(): Promise<StoredProviderProfile[]> {
    return [...this._profiles.values()];
  }

  async listEnabled(): Promise<StoredProviderProfile[]> {
    return [...this._profiles.values()].filter((p) => p.enabled);
  }

  async update(id: string, data: UpdateProfileData): Promise<StoredProviderProfile> {
    const existing = this._profiles.get(id);
    if (!existing) {
      throw new Error(`Profile ${id} not found`);
    }
    const updated: StoredProviderProfile = {
      ...existing,
      ...(data.name !== undefined && { name: data.name }),
      ...(data.credentialRef !== undefined && { credentialRef: data.credentialRef }),
      ...(data.endpointUrl !== undefined && { endpointUrl: data.endpointUrl }),
      ...(data.organizationId !== undefined && { organizationId: data.organizationId }),
      ...(data.defaultModelId !== undefined && { defaultModelId: data.defaultModelId }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      updatedAt: data.updatedAt,
    };
    this._profiles.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this._profiles.delete(id);
  }
}

export class InMemoryConversationModelRepository implements ConversationModelRepository {
  private readonly _models = new Map<string, StoredConversationModel>();

  async set(data: SetConversationModelData): Promise<StoredConversationModel> {
    const model: StoredConversationModel = {
      conversationId: data.conversationId,
      providerId: data.providerId,
      modelId: data.modelId,
      profileId: data.profileId ?? null,
      updatedAt: data.updatedAt,
    };
    this._models.set(data.conversationId, model);
    return model;
  }

  async getByConversationId(conversationId: string): Promise<StoredConversationModel | null> {
    return this._models.get(conversationId) ?? null;
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    this._models.delete(conversationId);
  }

  async listAll(): Promise<StoredConversationModel[]> {
    return [...this._models.values()];
  }
}

export interface TestModelSelectionOptions {
  adapter?: ProviderAdapter;
  models?: readonly ModelDefinition[];
  registry?: ProviderRegistry;
  profileRepo?: ProviderProfileRepository;
  conversationModelRepo?: ConversationModelRepository;
  defaultFallbackModelId?: ModelId;
}

export function createTestModelSelectionService(
  options?: TestModelSelectionOptions,
): ModelSelectionService {
  let registry = options?.registry;

  if (!registry) {
    registry = new ProviderRegistry();
    const adapter = options?.adapter;
    const models = options?.models ?? ANTHROPIC_MODELS;

    if (adapter) {
      registry.registerProvider({
        providerId: adapter.providerId,
        adapter,
      });
      for (const m of models) {
        registry.registerModel({ model: m });
      }
    }
  }

  const profileRepo = options?.profileRepo ?? new InMemoryProfileRepository();
  const conversationModelRepo =
    options?.conversationModelRepo ?? new InMemoryConversationModelRepository();

  return new ModelSelectionService({
    registry,
    profileRepo,
    conversationModelRepo,
    defaultFallbackModelId:
      options?.defaultFallbackModelId ?? options?.models?.[0]?.id ?? ANTHROPIC_MODELS[0].id,
  });
}

export interface TestChatServiceOptions {
  provider?: ProviderAdapter;
  models?: readonly ModelDefinition[];
  modelSelectionService?: ModelSelectionService;
  streamRegistry?: ActiveStreamRegistry;
  eventBus?: EventBus;
  storage?: EventRepository;
}

export function createTestChatService(options?: TestChatServiceOptions): ChatService {
  const streamRegistry = options?.streamRegistry ?? new ActiveStreamRegistry();
  const eventBus = options?.eventBus ?? new EventBus();
  const storage = options?.storage ?? new InMemoryEventRepository();

  let modelSelectionService = options?.modelSelectionService;
  if (!modelSelectionService) {
    modelSelectionService = createTestModelSelectionService({
      adapter: options?.provider,
      models: options?.models,
    });
  }

  return new ChatService({
    modelSelectionService,
    streamRegistry,
    eventBus,
    storage,
  });
}
