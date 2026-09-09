import { describe, expect, it } from "vitest";
import {
  createConversationId,
  createMessageId,
  generateUlid,
  now,
  ok,
  type ConversationId,
  type Result,
} from "@ai-desktop/shared";
import {
  createEventId,
  asModelId,
  asProviderId,
  type AIEvent,
  type ChatRequest,
  type ModelDefinition,
  type ModelId,
  type ProviderId,
} from "@ai-desktop/ai-core";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  GEMINI_MODELS,
  GEMINI_PROVIDER_ID,
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderConfigError,
} from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import {
  StorageDatabase,
  PrismaProviderProfileRepository,
  PrismaConversationModelRepository,
  type ConversationModelRepository,
  type CreateProfileData,
  type EventRepository,
  type ProviderProfileRepository,
  type SetConversationModelData,
  type StoredConversationModel,
  type StoredProviderProfile,
  type UpdateProfileData,
} from "@ai-desktop/storage";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { ChatService } from "../main/chat/chat-service.js";
import { ModelSelectionService } from "../main/chat/model-selection-service.js";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import { IPC_CHANNELS } from "@ai-desktop/shared";

// In-memory test doubles
class InMemoryEventRepository implements EventRepository {
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

class InMemoryProfileRepository implements ProviderProfileRepository {
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

class InMemoryConversationModelRepository implements ConversationModelRepository {
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

class RecordingProviderAdapter implements ProviderAdapter {
  readonly providerId: ProviderId;
  readonly chatCalls: ChatRequest[] = [];
  private readonly _models: readonly ModelDefinition[];

  constructor(providerId: ProviderId, models: readonly ModelDefinition[]) {
    this.providerId = providerId;
    this._models = models;
  }

  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return this._models;
  }
  async getModel(modelId: ModelId): Promise<ModelDefinition | undefined> {
    return this._models.find((m) => m.id === modelId);
  }
  validateConfig(): Result<void, ProviderConfigError> {
    return ok(undefined);
  }
  supports(): boolean {
    return true;
  }

  async *chat(request: ChatRequest): AsyncIterable<AIEvent> {
    this.chatCalls.push(request);
    const assistantMsgId = createMessageId();

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.started",
      category: "core",
      messageId: assistantMsgId,
      role: "assistant",
      content: [],
    };

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 1,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: assistantMsgId,
      deltaText: `Response from ${this.providerId} (${request.modelId})`,
    };

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 2,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: assistantMsgId,
    };
  }
}

function createTestHarness() {
  const anthropicAdapter = new RecordingProviderAdapter(ANTHROPIC_PROVIDER_ID, ANTHROPIC_MODELS);
  const geminiAdapter = new RecordingProviderAdapter(GEMINI_PROVIDER_ID, GEMINI_MODELS);

  const registry = new ProviderRegistry();
  registry.registerProvider({
    providerId: ANTHROPIC_PROVIDER_ID,
    adapter: anthropicAdapter,
  });
  for (const model of ANTHROPIC_MODELS) {
    registry.registerModel({ model });
  }

  registry.registerProvider({
    providerId: GEMINI_PROVIDER_ID,
    adapter: geminiAdapter,
  });
  for (const model of GEMINI_MODELS) {
    registry.registerModel({ model });
  }

  const profileRepo = new InMemoryProfileRepository();
  const conversationModelRepo = new InMemoryConversationModelRepository();

  const modelSelectionService = new ModelSelectionService({
    registry,
    profileRepo,
    conversationModelRepo,
    defaultFallbackModelId: ANTHROPIC_MODELS[0].id,
  });

  const streamRegistry = new ActiveStreamRegistry();
  const eventBus = new EventBus();
  const storage = new InMemoryEventRepository();

  const chatService = new ChatService({
    modelSelectionService,
    streamRegistry,
    eventBus,
    storage,
  });

  return {
    anthropicAdapter,
    geminiAdapter,
    registry,
    profileRepo,
    conversationModelRepo,
    modelSelectionService,
    streamRegistry,
    eventBus,
    storage,
    chatService,
  };
}

describe("PR22: ModelSelectionService Precedence & Routing", () => {
  it("resolves explicit model request with highest precedence", async () => {
    const { modelSelectionService, geminiAdapter } = createTestHarness();
    const convId = createConversationId();

    const route = await modelSelectionService.resolveForConversation(
      convId,
      "gemini:gemini-2.5-flash",
    );

    expect(route.selection.providerId).toBe("gemini");
    expect(route.selection.modelId).toBe("gemini:gemini-2.5-flash");
    expect(route.adapter).toBe(geminiAdapter);
  });

  it("resolves conversation's persisted model selection when no explicit request", async () => {
    const { modelSelectionService, conversationModelRepo, geminiAdapter } = createTestHarness();
    const convId = createConversationId();

    await conversationModelRepo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-pro",
      updatedAt: Date.now(),
    });

    const route = await modelSelectionService.resolveForConversation(convId);

    expect(route.selection.providerId).toBe("gemini");
    expect(route.selection.modelId).toBe("gemini:gemini-2.5-pro");
    expect(route.adapter).toBe(geminiAdapter);
  });

  it("resolves enabled profile default model when no conversation selection", async () => {
    const { modelSelectionService, profileRepo, geminiAdapter } = createTestHarness();
    const convId = createConversationId();

    await profileRepo.create({
      id: generateUlid(),
      providerId: "gemini",
      name: "Default Gemini Profile",
      defaultModelId: "gemini:gemini-2.5-flash-lite",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const route = await modelSelectionService.resolveForConversation(convId);

    expect(route.selection.providerId).toBe("gemini");
    expect(route.selection.modelId).toBe("gemini:gemini-2.5-flash-lite");
    expect(route.adapter).toBe(geminiAdapter);
  });

  it("falls back to global default model when no explicit request, conversation selection, or enabled profile", async () => {
    const { modelSelectionService, anthropicAdapter } = createTestHarness();
    const convId = createConversationId();

    const route = await modelSelectionService.resolveForConversation(convId);

    expect(route.selection.providerId).toBe("anthropic");
    expect(route.selection.modelId).toBe(ANTHROPIC_MODELS[0].id);
    expect(route.adapter).toBe(anthropicAdapter);
  });

  it("persists conversation model selection and retrieves it accurately", async () => {
    const { modelSelectionService } = createTestHarness();
    const convId = createConversationId();

    await modelSelectionService.setConversationModel(convId, {
      providerId: asProviderId("gemini"),
      modelId: asModelId("gemini:gemini-2.5-flash"),
    });

    const stored = await modelSelectionService.getConversationModel(convId);
    expect(stored).not.toBeNull();
    expect(stored!.providerId).toBe("gemini");
    expect(stored!.modelId).toBe("gemini:gemini-2.5-flash");
  });

  it("lists all available models across providers", () => {
    const { modelSelectionService } = createTestHarness();
    const models = modelSelectionService.listAvailableModels();

    const providerIds = new Set(models.map((m) => m.providerId));
    expect(providerIds.has(asProviderId("anthropic"))).toBe(true);
    expect(providerIds.has(asProviderId("gemini"))).toBe(true);
    expect(models.length).toBe(ANTHROPIC_MODELS.length + GEMINI_MODELS.length);
  });

  it("creates, validates, updates, and deletes provider profiles", async () => {
    const { modelSelectionService } = createTestHarness();

    const created = await modelSelectionService.createProfile({
      providerId: asProviderId("gemini"),
      name: "Work Gemini",
      credentialRef: "app/provider/gemini/work-key",
      defaultModelId: asModelId("gemini:gemini-2.5-flash"),
      enabled: true,
    });

    expect(created.name).toBe("Work Gemini");
    expect(created.providerId).toBe("gemini");

    const updated = await modelSelectionService.updateProfile(created.id, {
      name: "Updated Work Gemini",
      updatedAt: Date.now(),
    });
    expect(updated.name).toBe("Updated Work Gemini");

    await modelSelectionService.deleteProfile(created.id);
    const all = await modelSelectionService.listProfiles();
    expect(all.find((p) => p.id === created.id)).toBeUndefined();
  });
});

describe("PR22: ChatService Multi-Provider Routing", () => {
  it("routes to Gemini adapter when Gemini model is requested", async () => {
    const { chatService, geminiAdapter, anthropicAdapter, storage } = createTestHarness();
    const convId = createConversationId();

    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Hello Gemini!",
      modelId: "gemini:gemini-2.5-flash",
    });

    await result.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(geminiAdapter.chatCalls[0].modelId).toBe("gemini:gemini-2.5-flash");
    expect(anthropicAdapter.chatCalls).toHaveLength(0);

    const storedEvents = await storage.getByConversation(convId);
    expect(storedEvents.length).toBeGreaterThan(0);
  });

  it("routes to Anthropic adapter when Anthropic model is requested", async () => {
    const { chatService, geminiAdapter, anthropicAdapter } = createTestHarness();
    const convId = createConversationId();

    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Hello Claude!",
      modelId: ANTHROPIC_MODELS[0].id,
    });

    await result.completion;

    expect(anthropicAdapter.chatCalls).toHaveLength(1);
    expect(anthropicAdapter.chatCalls[0].modelId).toBe(ANTHROPIC_MODELS[0].id);
    expect(geminiAdapter.chatCalls).toHaveLength(0);
  });

  it("routes subsequent messages to conversation's configured model without re-specifying modelId", async () => {
    const { chatService, modelSelectionService, geminiAdapter } = createTestHarness();
    const convId = createConversationId();

    // Set conversation model to Gemini
    await modelSelectionService.setConversationModel(convId, {
      providerId: asProviderId("gemini"),
      modelId: asModelId("gemini:gemini-2.5-pro"),
    });

    // Send message WITHOUT modelId in input
    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Follow-up message",
    });

    await result.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(geminiAdapter.chatCalls[0].modelId).toBe("gemini:gemini-2.5-pro");
  });
});

describe("PR22: Typed IPC Handlers for Profiles and Models", () => {
  it("dispatches provider:models-list and returns registered models", async () => {
    const { modelSelectionService } = createTestHarness();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { modelSelectionService });

    const response = await registry.invokeCommand<{ models: ModelDefinition[] }>(
      IPC_CHANNELS.PROVIDER_MODELS_LIST,
      {},
    );

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value.models.length).toBeGreaterThanOrEqual(5);
      const ids = response.value.models.map((m) => m.id);
      expect(ids).toContain("gemini:gemini-2.5-flash");
      expect(ids).toContain(ANTHROPIC_MODELS[0].id);
    }
  });

  it("dispatches provider profile CRUD commands over IPC", async () => {
    const { modelSelectionService } = createTestHarness();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { modelSelectionService });

    // 1. Create profile
    const createRes = await registry.invokeCommand<{ profile: StoredProviderProfile }>(
      IPC_CHANNELS.PROVIDER_PROFILE_CREATE,
      {
        providerId: "gemini",
        name: "IPC Gemini Profile",
        credentialRef: "app/provider/gemini/ipc-key",
        defaultModelId: "gemini:gemini-2.5-flash",
        enabled: true,
      },
    );

    expect(createRes.ok).toBe(true);
    let profileId = "";
    if (createRes.ok) {
      profileId = createRes.value.profile.id;
      expect(createRes.value.profile.name).toBe("IPC Gemini Profile");
    }

    // 2. List profiles
    const listRes = await registry.invokeCommand<{ profiles: StoredProviderProfile[] }>(
      IPC_CHANNELS.PROVIDER_PROFILES_LIST,
      {},
    );
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.value.profiles.some((p) => p.id === profileId)).toBe(true);
    }

    // 3. Update profile
    const updateRes = await registry.invokeCommand<{ profile: StoredProviderProfile }>(
      IPC_CHANNELS.PROVIDER_PROFILE_UPDATE,
      {
        id: profileId,
        name: "Updated IPC Gemini Profile",
      },
    );
    expect(updateRes.ok).toBe(true);
    if (updateRes.ok) {
      expect(updateRes.value.profile.name).toBe("Updated IPC Gemini Profile");
    }

    // 4. Delete profile
    const deleteRes = await registry.invokeCommand<{ deleted: boolean; id: string }>(
      IPC_CHANNELS.PROVIDER_PROFILE_DELETE,
      { id: profileId },
    );
    expect(deleteRes.ok).toBe(true);
    if (deleteRes.ok) {
      expect(deleteRes.value.deleted).toBe(true);
    }
  });

  it("dispatches conversation:model-set and conversation:model-get over IPC", async () => {
    const { modelSelectionService } = createTestHarness();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { modelSelectionService });

    const convId = createConversationId();

    // Set model
    const setRes = await registry.invokeCommand<{ modelSelection: StoredConversationModel }>(
      IPC_CHANNELS.CONVERSATION_MODEL_SET,
      {
        conversationId: convId,
        providerId: "gemini",
        modelId: "gemini:gemini-2.5-flash",
      },
    );
    expect(setRes.ok).toBe(true);
    if (setRes.ok) {
      expect(setRes.value.modelSelection.modelId).toBe("gemini:gemini-2.5-flash");
    }

    // Get model
    const getRes = await registry.invokeCommand<{ modelSelection: StoredConversationModel }>(
      IPC_CHANNELS.CONVERSATION_MODEL_GET,
      {
        conversationId: convId,
      },
    );
    expect(getRes.ok).toBe(true);
    if (getRes.ok) {
      expect(getRes.value.modelSelection.modelId).toBe("gemini:gemini-2.5-flash");
    }
  });
});

describe("PR22: SQLite WAL Model Selection Restart Recovery", () => {
  it("preserves conversation model selection across database close and reopen", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-convmodel-recovery-"));
    const tmpDbPath = path.join(tmpDir, "recovery.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    const convId = createConversationId();

    // Session 1: configure conversation model in SQLite
    const db1 = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db1.initialize();

    const convModelRepo1 = new PrismaConversationModelRepository(db1);
    const profileRepo1 = new PrismaProviderProfileRepository(db1);

    const registry1 = new ProviderRegistry();
    registry1.registerProvider({
      providerId: GEMINI_PROVIDER_ID,
      adapter: new RecordingProviderAdapter(GEMINI_PROVIDER_ID, GEMINI_MODELS),
    });
    for (const model of GEMINI_MODELS) {
      registry1.registerModel({ model });
    }

    const service1 = new ModelSelectionService({
      registry: registry1,
      profileRepo: profileRepo1,
      conversationModelRepo: convModelRepo1,
    });

    await service1.setConversationModel(convId, {
      providerId: asProviderId("gemini"),
      modelId: asModelId("gemini:gemini-2.5-pro"),
    });

    // Close session 1
    await db1.close();

    // Session 2: simulate desktop app restart on the same SQLite WAL database
    const db2 = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db2.initialize();

    const convModelRepo2 = new PrismaConversationModelRepository(db2);
    const profileRepo2 = new PrismaProviderProfileRepository(db2);

    const service2 = new ModelSelectionService({
      registry: registry1,
      profileRepo: profileRepo2,
      conversationModelRepo: convModelRepo2,
    });

    // Model selection is cleanly restored from persistent storage
    const restoredRoute = await service2.resolveForConversation(convId);
    expect(restoredRoute.selection.providerId).toBe("gemini");
    expect(restoredRoute.selection.modelId).toBe("gemini:gemini-2.5-pro");

    await db2.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });
});
