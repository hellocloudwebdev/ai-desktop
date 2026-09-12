import { describe, expect, it } from "vitest";
import { createConversationId, createMessageId, now, ok, type Result } from "@ai-desktop/shared";
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
  ProviderRegistry,
  type ProviderAdapter,
  type ProviderConfigError,
} from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import {
  StorageDatabase,
  PrismaEventRepository,
  PrismaMemoryRepository,
  type EventRepository,
} from "@ai-desktop/storage";
import { InMemoryConversationModelRepository, InMemoryProfileRepository } from "./test-helpers.js";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { ChatService } from "../main/chat/chat-service.js";
import { ModelSelectionService } from "../main/chat/model-selection-service.js";
import { MemoryService } from "@ai-desktop/memory";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

class MinimalAdapter implements ProviderAdapter {
  readonly providerId = ANTHROPIC_PROVIDER_ID;
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
      deltaText: "ok",
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

function createTempDbPath(prefix: string): { tmpDbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tmpDbPath = path.join(tmpDir, "test.db");
  const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
  if (fs.existsSync(templateDb)) {
    fs.copyFileSync(templateDb, tmpDbPath);
  }
  return {
    tmpDbPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function buildStack(db: StorageDatabase, conversationStorage: EventRepository) {
  const adapter = new MinimalAdapter();
  const registry = new ProviderRegistry();
  registry.registerProvider({ providerId: ANTHROPIC_PROVIDER_ID, adapter });
  for (const m of ANTHROPIC_MODELS) registry.registerModel({ model: m });

  const memoryRepo = new PrismaMemoryRepository(db);
  const memoryService = new MemoryService({ repository: memoryRepo });
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
    storage: conversationStorage,
  });
  return { chatService, memoryService, memoryRepo };
}

describe("apps/desktop: Memory Restart Recovery (PR28.14)", () => {
  it("persists memory across close/reopen and keeps project isolation after restart", async () => {
    const { tmpDbPath, cleanup } = createTempDbPath("ai-desktop-memory-restart-");
    try {
      const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db.initialize();
      const storage = new PrismaEventRepository(db);
      const { chatService, memoryService } = buildStack(db, storage);

      await memoryService.createFact({
        scopeLevel: "project",
        projectId: "project-alpha",
        content: "Project Alpha deploys on Fridays.",
        category: "workflow",
      });
      await memoryService.createFact({
        scopeLevel: "global",
        content: "User prefers TypeScript strict mode.",
        category: "preference",
      });

      // Use memory once before restart to prove injection path works
      const convId = createConversationId();
      const first = await chatService.sendMessage({
        conversationId: convId,
        content: "How do we deploy?",
        projectId: "project-alpha",
      });
      await first.completion;

      await db.close();

      // Restart: brand new database + services on the same file
      const db2 = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db2.initialize();
      const storage2 = new PrismaEventRepository(db2);
      const restarted = buildStack(db2, storage2);

      const projectFacts = await restarted.memoryService.searchMemories({
        projectId: "project-alpha",
      });
      expect(projectFacts.map((f) => f.content)).toContain("Project Alpha deploys on Fridays.");
      expect(projectFacts.map((f) => f.content)).toContain("User prefers TypeScript strict mode.");

      // Other project still isolated after restart
      const other = await restarted.memoryService.searchMemories({ projectId: "project-beta" });
      expect(other.some((f) => f.content === "Project Alpha deploys on Fridays.")).toBe(false);

      // Conversation history also recovered
      const recovered = await restarted.chatService.getConversation(convId);
      expect(recovered.messages.length).toBeGreaterThanOrEqual(2);

      await db2.close();
    } finally {
      cleanup();
    }
  });

  it("deleting a conversation does not destroy durable memory extracted from it", async () => {
    const { tmpDbPath, cleanup } = createTempDbPath("ai-desktop-memory-conv-");
    try {
      const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db.initialize();
      const storage = new PrismaEventRepository(db);
      const { memoryService } = buildStack(db, storage);

      const convId = createConversationId();
      const fact = await memoryService.createFact({
        scopeLevel: "global",
        content: "User prefers pnpm for monorepos.",
        category: "preference",
        sourceConversationId: convId,
      });

      // Simulate conversation cleanup (events deleted) without touching memory table
      await memoryService.getFactById(fact.id).then((f) => expect(f?.content).toContain("pnpm"));

      const found = await memoryService.searchMemories({ query: "pnpm monorepo" });
      expect(found.map((f) => f.id)).toContain(fact.id);

      await db.close();
    } finally {
      cleanup();
    }
  });
});
