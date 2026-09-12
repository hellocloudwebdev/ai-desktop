import { describe, expect, it } from "vitest";
import {
  createConversationId,
  createMessageId,
  now,
  ok,
  type ConversationId,
  type Result,
} from "@ai-desktop/shared";
import {
  createEventId,
  type AIEvent,
  type ChatRequest,
  type MessageCompletedEvent,
  type MessageDeltaEvent,
  type MessageStartedEvent,
  type ModelDefinition,
  type ModelId,
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
import { type EventRepository } from "@ai-desktop/storage";
import { InMemoryConversationModelRepository, InMemoryProfileRepository } from "./test-helpers.js";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { ChatService } from "../main/chat/chat-service.js";
import { ModelSelectionService } from "../main/chat/model-selection-service.js";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import { MemoryService } from "@ai-desktop/memory";
import { IPC_CHANNELS } from "@ai-desktop/shared";

class InMemoryEventRepository implements EventRepository {
  private readonly _events = new Map<ConversationId, AIEvent[]>();

  async append(event: Readonly<AIEvent>): Promise<void> {
    const list = this._events.get(event.conversationId) ?? [];
    list.push(event as AIEvent);
    this._events.set(event.conversationId, list);
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    return [...(this._events.get(conversationId) ?? [])];
  }
}

class InMemoryMemoryRepository {
  private readonly _facts: Array<{
    id: string;
    scopeLevel: string;
    projectId: string | null;
    content: string;
    category: string;
    sensitivity: string;
    sourceConversationId: string | null;
    confidence: number;
    createdAt: number;
    updatedAt: number;
    supersededBy: string | null;
  }> = [];

  async createFact(data: {
    id: string;
    scopeLevel: string;
    projectId?: string | null;
    content: string;
    category: string;
    sensitivity?: string;
    sourceConversationId?: string | null;
    confidence?: number;
    createdAt: number;
    updatedAt: number;
  }) {
    const fact = {
      id: data.id,
      scopeLevel: data.scopeLevel,
      projectId: data.projectId ?? null,
      content: data.content,
      category: data.category,
      sensitivity: data.sensitivity ?? "normal",
      sourceConversationId: data.sourceConversationId ?? null,
      confidence: data.confidence ?? 1.0,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      supersededBy: null as string | null,
    };
    this._facts.push(fact);
    return fact;
  }

  async getFactById(id: string) {
    return this._facts.find((f) => f.id === id) ?? null;
  }

  async listFacts(query?: {
    projectId?: string;
    scopeLevel?: string;
    category?: string;
    includeSuperseded?: boolean;
    limit?: number;
  }) {
    return this._facts
      .filter((f) => {
        if (query?.projectId !== undefined) {
          if (!(f.scopeLevel === "global" || f.projectId === query.projectId)) return false;
        } else if (query?.scopeLevel === undefined && f.scopeLevel === "project") {
          return false;
        }
        if (query?.scopeLevel !== undefined && f.scopeLevel !== query.scopeLevel) return false;
        if (query?.category !== undefined && f.category !== query.category) return false;
        if (!query?.includeSuperseded && f.supersededBy !== null) return false;
        return true;
      })
      .slice(0, query?.limit);
  }

  async updateFact(
    id: string,
    updates: { content?: string; category?: string; sensitivity?: string; confidence?: number },
  ) {
    const fact = this._facts.find((f) => f.id === id);
    if (!fact) throw new Error(`Memory fact "${id}" not found`);
    const updated = { ...fact, ...updates, updatedAt: Date.now() };
    const idx = this._facts.findIndex((f) => f.id === id);
    this._facts[idx] = updated;
    return updated;
  }

  async supersedeFact(id: string, supersededBy: string) {
    const fact = this._facts.find((f) => f.id === id);
    if (!fact) throw new Error(`Memory fact "${id}" not found`);
    const updated = { ...fact, supersededBy, updatedAt: Date.now() };
    const idx = this._facts.findIndex((f) => f.id === id);
    this._facts[idx] = updated;
    return updated;
  }

  async deleteFact(id: string) {
    const idx = this._facts.findIndex((f) => f.id === id);
    if (idx >= 0) this._facts.splice(idx, 1);
  }

  async deleteProjectFacts(projectId: string) {
    let count = 0;
    for (let i = this._facts.length - 1; i >= 0; i--) {
      if (this._facts[i].scopeLevel === "project" && this._facts[i].projectId === projectId) {
        this._facts.splice(i, 1);
        count++;
      }
    }
    return count;
  }
}

class RecordingProviderAdapter implements ProviderAdapter {
  readonly providerId = ANTHROPIC_PROVIDER_ID;
  readonly chatCalls: ChatRequest[] = [];
  private readonly _models = new Map<string, ModelDefinition>(
    ANTHROPIC_MODELS.map((m) => [m.id, m]),
  );

  async initialize(): Promise<void> {}
  async listModels(): Promise<readonly ModelDefinition[]> {
    return [...this._models.values()];
  }
  async getModel(modelId: ModelId): Promise<ModelDefinition | undefined> {
    return this._models.get(modelId);
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
    } as MessageStartedEvent;

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.delta",
      category: "core",
      messageId: assistantMsgId,
      deltaText: "Acknowledged.",
    } as MessageDeltaEvent;

    yield {
      eventId: createEventId(),
      conversationId: request.conversationId,
      sequence: 0,
      schemaVersion: 1,
      timestamp: now(),
      type: "message.completed",
      category: "core",
      messageId: assistantMsgId,
      finishReason: "end_turn",
    } as MessageCompletedEvent;
  }
}

function createHarness() {
  const adapter = new RecordingProviderAdapter();
  const registry = new ProviderRegistry();
  registry.registerProvider({ providerId: ANTHROPIC_PROVIDER_ID, adapter });
  for (const m of ANTHROPIC_MODELS) registry.registerModel({ model: m });
  registry.registerProvider({
    providerId: GEMINI_PROVIDER_ID,
    adapter: new RecordingProviderAdapter(),
  } as unknown as { providerId: typeof GEMINI_PROVIDER_ID; adapter: ProviderAdapter });
  void GEMINI_MODELS;

  const profileRepo = new InMemoryProfileRepository();
  const conversationModelRepo = new InMemoryConversationModelRepository();
  const memoryRepo = new InMemoryMemoryRepository();
  const memoryService = new MemoryService({ repository: memoryRepo });

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
    memoryService,
    streamRegistry,
    eventBus,
    storage,
  });

  return {
    adapter,
    registry,
    memoryRepo,
    memoryService,
    chatService,
    storage,
    streamRegistry,
    eventBus,
  };
}

describe("apps/desktop: Memory Integration (PR28.11, PR28.14–PR28.16)", () => {
  it("injects relevant project import_guard into provider systemPrompt without modifying history", async () => {
    const { adapter, memoryService, chatService } = createHarness();

    await memoryService.createFact({
      scopeLevel: "project",
      projectId: "project-alpha",
      content: "Project Alpha uses pnpm with strict peer dependencies.",
      category: "project_context",
    });

    const convId = createConversationId();
    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "How should I install dependencies here?",
      projectId: "project-alpha",
    });
    await result.completion;

    expect(adapter.chatCalls).toHaveLength(1);
    const systemPrompt = adapter.chatCalls[0].systemPrompt ?? "";
    expect(systemPrompt).toContain("Project Alpha uses pnpm");

    // Historical messages are untouched
    const messages = adapter.chatCalls[0].messages;
    expect(
      messages.every(
        (m) =>
          !m.content.some((p) => p.type === "text" && p.text.includes("Project Alpha uses pnpm")),
      ),
    ).toBe(true);
  });

  it("PROMPT LEAKAGE: Project B confidential detail never enters a Project A provider request", async () => {
    const { adapter, memoryService, chatService } = createHarness();

    await memoryService.createFact({
      scopeLevel: "project",
      projectId: "project-B",
      content: "Project B confidential architecture detail: internal token vault layout.",
      category: "project_context",
    });

    const convId = createConversationId();
    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Describe the architecture here.",
      projectId: "project-A",
    });
    await result.completion;

    const systemPrompt = adapter.chatCalls[0].systemPrompt ?? "";
    expect(systemPrompt).not.toContain("confidential architecture detail");
  });

  it("sensitive facts are excluded from automatic injection", async () => {
    const { adapter, memoryService, chatService } = createHarness();

    await memoryService.createFact({
      scopeLevel: "global",
      content: "Salary review cycle is in March.",
      category: "fact",
      sensitivity: "sensitive",
    });

    const convId = createConversationId();
    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Tell me about the review schedule.",
    });
    await result.completion;

    const systemPrompt = adapter.chatCalls[0].systemPrompt ?? "";
    expect(systemPrompt).not.toContain("Salary review cycle");
  });

  it("injection can be disabled while facts remain stored", async () => {
    const { adapter, memoryService, chatService } = createHarness();

    await memoryService.createFact({
      scopeLevel: "global",
      content: "User prefers pnpm for monorepos.",
      category: "preference",
    });

    memoryService.setInjectionEnabled(false);

    const convId = createConversationId();
    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Which package manager should I use?",
    });
    await result.completion;

    const systemPrompt = adapter.chatCalls[0].systemPrompt ?? "";
    expect(systemPrompt).not.toContain("pnpm");

    const stored = await memoryService.searchMemories({});
    expect(stored).toHaveLength(1);

    memoryService.setInjectionEnabled(true);
  });

  it("injects memory provider-neutrally for Gemini as well", async () => {
    const geminiAdapter = new (class extends RecordingProviderAdapter {
      override readonly providerId = GEMINI_PROVIDER_ID;
    })();
    const registry = new ProviderRegistry();
    registry.registerProvider({
      providerId: ANTHROPIC_PROVIDER_ID,
      adapter: new RecordingProviderAdapter(),
    });
    for (const m of ANTHROPIC_MODELS) registry.registerModel({ model: m });
    registry.registerProvider({ providerId: GEMINI_PROVIDER_ID, adapter: geminiAdapter });
    for (const m of GEMINI_MODELS) {
      if (m.providerId === GEMINI_PROVIDER_ID) registry.registerModel({ model: m });
    }

    const memoryRepo = new InMemoryMemoryRepository();
    const memoryService = new MemoryService({ repository: memoryRepo });
    await memoryService.createFact({
      scopeLevel: "global",
      content: "User prefers TypeScript strict mode.",
      category: "preference",
    });

    const modelSelectionService = new ModelSelectionService({
      registry,
      profileRepo: new InMemoryProfileRepository(),
      conversationModelRepo: new InMemoryConversationModelRepository(),
      defaultFallbackModelId: ANTHROPIC_MODELS[0].id,
    });

    const chatService = new ChatService({
      modelSelectionService,
      memoryService,
      streamRegistry: new ActiveStreamRegistry(),
      eventBus: new EventBus(),
      storage: new InMemoryEventRepository(),
    });

    const convId = createConversationId();
    const geminiModel = GEMINI_MODELS.find((m) => m.providerId === GEMINI_PROVIDER_ID);
    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Which language settings apply?",
      modelId: geminiModel?.id,
    });
    await result.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(geminiAdapter.chatCalls[0].systemPrompt ?? "").toContain("TypeScript strict mode");
  });

  it("dispatches import_guard CRUD over typed IPC", async () => {
    const { memoryService } = createHarness();
    const registry = new IpcRegistry();
    registerIpcHandlers(registry, { memoryService } as unknown as Parameters<
      typeof registerIpcHandlers
    >[1]);

    const created = await memoryService.createFact({
      scopeLevel: "global",
      content: "User reviews code every Friday afternoon.",
      category: "workflow",
    });

    // MEMORY_LIST
    const listRes = await registry.invokeCommand<{ facts: Array<{ id: string }> }>(
      IPC_CHANNELS.MEMORY_LIST,
      {},
    );
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.value.facts.some((f) => f.id === created.id)).toBe(true);
    }

    // MEMORY_GET
    const getRes = await registry.invokeCommand<{ fact: { content: string } | null }>(
      IPC_CHANNELS.MEMORY_GET,
      { id: created.id },
    );
    expect(getRes.ok).toBe(true);

    // MEMORY_SEARCH
    const searchRes = await registry.invokeCommand<{ facts: Array<{ id: string }> }>(
      IPC_CHANNELS.MEMORY_SEARCH,
      { query: "Friday afternoon" },
    );
    expect(searchRes.ok).toBe(true);
    if (searchRes.ok) {
      expect(searchRes.value.facts.some((f) => f.id === created.id)).toBe(true);
    }

    // MEMORY_UPDATE
    const updateRes = await registry.invokeCommand<{ fact: { content: string } }>(
      IPC_CHANNELS.MEMORY_UPDATE,
      { id: created.id, content: "User reviews code every Friday morning." },
    );
    expect(updateRes.ok).toBe(true);

    // MEMORY_DELETE
    const deleteRes = await registry.invokeCommand<{ deleted: boolean }>(
      IPC_CHANNELS.MEMORY_DELETE,
      { id: created.id },
    );
    expect(deleteRes.ok).toBe(true);
    if (deleteRes.ok) {
      expect(deleteRes.value.deleted).toBe(true);
    }
  });
});
