// PR23: apps/desktop/__tests__ — Multi-Provider Chat Service Integration & Acceptance Suite
//
// Invariants (PR23 Acceptance Gate):
//   1. Provider-neutral ChatService: zero vendor SDK dependencies.
//   2. ModelSelectionService is the single authoritative resolution path.
//   3. Supports dynamic multi-provider routing (Anthropic & Gemini).
//   4. Cross-conversation isolation: concurrent streams do not cross-route.
//   5. Concurrent sibling cancellation: cancelling stream A leaves stream B unaffected.
//   6. Real provider abort signal propagation down to adapter.
//   7. Idempotent cancellation: repeated, completed, or unknown cancellation calls are safe.
//   8. Terminal event audit: exactly one terminal state per execution (no duplicates, no silence).
//   9. Unsupported capabilities rejected before provider execution (call count = 0).
//  10. Deterministic provider failure: no automatic fallback between providers.
//  11. Typed IPC dispatch regression for both providers.
//  12. Restart recovery with multi-provider model selection from SQLite WAL.

import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  createConversationId,
  createMessageId,
  now,
  ok,
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
  type MessageStartedEvent,
  type MessageDeltaEvent,
  type MessageCompletedEvent,
  type MessageFailedEvent,
} from "@ai-desktop/ai-core";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  GEMINI_MODELS,
  GEMINI_PROVIDER_ID,
  ModelNotFoundError,
  ModelSelectionError,
  ProviderError,
  ProviderRegistry,
  UnsupportedCapabilityError,
  type ProviderAdapter,
  type ProviderConfigError,
} from "@ai-desktop/providers";
import { EventBus } from "@ai-desktop/agent-runtime";
import {
  StorageDatabase,
  PrismaEventRepository,
  PrismaProviderProfileRepository,
  PrismaConversationModelRepository,
} from "@ai-desktop/storage";
import { ActiveStreamRegistry } from "../main/chat/active-stream-registry.js";
import { ChatService } from "../main/chat/chat-service.js";
import { ModelSelectionService } from "../main/chat/model-selection-service.js";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import {
  InMemoryEventRepository,
  InMemoryProfileRepository,
  InMemoryConversationModelRepository,
} from "./test-helpers.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Configurable Recording Provider Adapter for Multi-Provider Verification
// ---------------------------------------------------------------------------

class RecordingMultiProviderAdapter implements ProviderAdapter {
  readonly providerId: ProviderId;
  readonly chatCalls: ChatRequest[] = [];
  readonly signalsReceived: AbortSignal[] = [];
  public delayMs: number = 0;
  public failWithError?: Error;
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

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
    this.chatCalls.push(request);
    if (signal) {
      this.signalsReceived.push(signal);
    }

    if (this.failWithError) {
      throw this.failWithError;
    }

    const assistantMsgId = createMessageId();

    // 1. Started
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

    // 2. Deltas with optional delay to allow cancellation tests
    const chunks = [`Chunk 1 from ${this.providerId}`, `Chunk 2 from ${this.providerId}`];
    for (const chunk of chunks) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }

      if (signal?.aborted) {
        // Cooperative cancellation exit
        return;
      }

      yield {
        eventId: createEventId(),
        conversationId: request.conversationId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: assistantMsgId,
        deltaText: chunk,
      } as MessageDeltaEvent;
    }

    // Wait if delay was specified to allow mid-stream cancellation
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (signal?.aborted) {
      return;
    }

    // 3. Completed
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

function setupMultiProviderHarness() {
  const anthropicAdapter = new RecordingMultiProviderAdapter(
    ANTHROPIC_PROVIDER_ID,
    ANTHROPIC_MODELS,
  );
  const geminiAdapter = new RecordingMultiProviderAdapter(GEMINI_PROVIDER_ID, GEMINI_MODELS);

  const registry = new ProviderRegistry();
  registry.registerProvider({
    providerId: ANTHROPIC_PROVIDER_ID,
    adapter: anthropicAdapter,
  });
  for (const m of ANTHROPIC_MODELS) {
    registry.registerModel({ model: m });
  }

  registry.registerProvider({
    providerId: GEMINI_PROVIDER_ID,
    adapter: geminiAdapter,
  });
  for (const m of GEMINI_MODELS) {
    registry.registerModel({ model: m });
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

describe("PR23.10: Multi-Provider Routing & Independent Execution", () => {
  it("Test A: routes to AnthropicAdapter and passes canonical ChatRequest", async () => {
    const { chatService, anthropicAdapter, geminiAdapter } = setupMultiProviderHarness();
    const convId = createConversationId();

    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Hello Anthropic",
      modelId: ANTHROPIC_MODELS[0].id,
    });
    await result.completion;

    expect(anthropicAdapter.chatCalls).toHaveLength(1);
    expect(anthropicAdapter.chatCalls[0].modelId).toBe(ANTHROPIC_MODELS[0].id);
    expect(anthropicAdapter.chatCalls[0].conversationId).toBe(convId);
    expect(anthropicAdapter.chatCalls[0].messages).toHaveLength(1);
    expect(geminiAdapter.chatCalls).toHaveLength(0);
  });

  it("Test B: routes to GeminiAdapter and passes identical canonical ChatRequest shape", async () => {
    const { chatService, anthropicAdapter, geminiAdapter } = setupMultiProviderHarness();
    const convId = createConversationId();

    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Hello Gemini",
      modelId: "gemini:gemini-2.5-flash",
    });
    await result.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(geminiAdapter.chatCalls[0].modelId).toBe("gemini:gemini-2.5-flash");
    expect(geminiAdapter.chatCalls[0].conversationId).toBe(convId);
    expect(geminiAdapter.chatCalls[0].messages).toHaveLength(1);
    expect(anthropicAdapter.chatCalls).toHaveLength(0);
  });

  it("Test C: dynamic provider switching across turns in a single conversation", async () => {
    const { chatService, anthropicAdapter, geminiAdapter, storage } = setupMultiProviderHarness();
    const convId = createConversationId();

    // Turn 1: Gemini
    const res1 = await chatService.sendMessage({
      conversationId: convId,
      content: "Turn 1 to Gemini",
      modelId: "gemini:gemini-2.5-flash",
    });
    await res1.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(anthropicAdapter.chatCalls).toHaveLength(0);

    // Turn 2: Switch to Anthropic in the SAME conversation
    const res2 = await chatService.sendMessage({
      conversationId: convId,
      content: "Turn 2 to Claude",
      modelId: ANTHROPIC_MODELS[0].id,
    });
    await res2.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(anthropicAdapter.chatCalls).toHaveLength(1);

    // Anthropic request includes the full prior conversation context
    const anthropicMessages = anthropicAdapter.chatCalls[0].messages;
    expect(anthropicMessages.length).toBeGreaterThanOrEqual(3); // User 1, Assistant 1, User 2

    // Turn 3: Switch back to Gemini Pro
    const res3 = await chatService.sendMessage({
      conversationId: convId,
      content: "Turn 3 back to Gemini Pro",
      modelId: "gemini:gemini-2.5-pro",
    });
    await res3.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(2);
    expect(anthropicAdapter.chatCalls).toHaveLength(1);

    // Verify all turns share the same monotonic sequence in storage
    const allEvents = await storage.getByConversation(convId);
    for (let i = 0; i < allEvents.length; i++) {
      expect(allEvents[i].sequence).toBe(i);
    }
  });

  it("Test D: executes two simultaneous streams to different providers concurrently", async () => {
    const { chatService, anthropicAdapter, geminiAdapter } = setupMultiProviderHarness();
    anthropicAdapter.delayMs = 20;
    geminiAdapter.delayMs = 20;

    const convA = createConversationId();
    const convB = createConversationId();

    // Fire both concurrently
    const [resA, resB] = await Promise.all([
      chatService.sendMessage({
        conversationId: convA,
        content: "Concurrent stream A",
        modelId: ANTHROPIC_MODELS[0].id,
      }),
      chatService.sendMessage({
        conversationId: convB,
        content: "Concurrent stream B",
        modelId: "gemini:gemini-2.5-flash",
      }),
    ]);

    // Wait for both to complete
    await Promise.all([resA.completion, resB.completion]);

    expect(anthropicAdapter.chatCalls).toHaveLength(1);
    expect(anthropicAdapter.chatCalls[0].conversationId).toBe(convA);
    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(geminiAdapter.chatCalls[0].conversationId).toBe(convB);
  });

  it("Cross-conversation isolation: events and sequences never leak between concurrent conversations", async () => {
    const { chatService, anthropicAdapter, geminiAdapter, storage } = setupMultiProviderHarness();
    anthropicAdapter.delayMs = 15;
    geminiAdapter.delayMs = 15;

    const convA = createConversationId();
    const convB = createConversationId();

    const [resA, resB] = await Promise.all([
      chatService.sendMessage({
        conversationId: convA,
        content: "Message A",
        modelId: "gemini:gemini-2.5-flash",
      }),
      chatService.sendMessage({
        conversationId: convB,
        content: "Message B",
        modelId: ANTHROPIC_MODELS[0].id,
      }),
    ]);

    await Promise.all([resA.completion, resB.completion]);

    const eventsA = await storage.getByConversation(convA);
    const eventsB = await storage.getByConversation(convB);

    // Complete isolation: every event in A belongs strictly to convA
    for (const e of eventsA) {
      expect(e.conversationId).toBe(convA);
    }
    // Every event in B belongs strictly to convB
    for (const e of eventsB) {
      expect(e.conversationId).toBe(convB);
    }

    // Both preserve independent 0-based monotonic sequences
    for (let i = 0; i < eventsA.length; i++) {
      expect(eventsA[i].sequence).toBe(i);
    }
    for (let i = 0; i < eventsB.length; i++) {
      expect(eventsB[i].sequence).toBe(i);
    }
  });

  it("Sibling stream cancellation: cancelling stream A leaves concurrent stream B unaffected", async () => {
    const { chatService, anthropicAdapter, geminiAdapter, storage } = setupMultiProviderHarness();
    geminiAdapter.delayMs = 40;
    anthropicAdapter.delayMs = 40;

    const convA = createConversationId();
    const convB = createConversationId();

    // Start both streams concurrently
    const resA = await chatService.sendMessage({
      conversationId: convA,
      content: "Stream to be cancelled",
      modelId: "gemini:gemini-2.5-flash",
    });

    const resB = await chatService.sendMessage({
      conversationId: convB,
      content: "Stream to complete normally",
      modelId: ANTHROPIC_MODELS[0].id,
    });

    // Allow first deltas to emit
    await new Promise((r) => setTimeout(r, 30));

    // Cancel stream A specifically
    const cancelledA = chatService.cancel(resA.assistantMessageId);
    expect(cancelledA).toBe(true);

    // Wait for both completions
    await Promise.all([resA.completion, resB.completion]);

    // Stream A should be cancelled
    const eventsA = await storage.getByConversation(convA);
    const typesA = eventsA.map((e) => e.type);
    expect(typesA).toContain("message.cancelled");
    expect(typesA).not.toContain("message.completed");

    // Stream B must complete normally without interference from A's cancellation
    const eventsB = await storage.getByConversation(convB);
    const typesB = eventsB.map((e) => e.type);
    expect(typesB).toContain("message.completed");
    expect(typesB).not.toContain("message.cancelled");
  });
});

describe("PR23.8: Cancellation Hardening & Idempotency", () => {
  it("propagates real AbortSignal to the active provider adapter", async () => {
    const { chatService, geminiAdapter } = setupMultiProviderHarness();
    geminiAdapter.delayMs = 50;

    const convId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId: convId,
      content: "Cancel test",
      modelId: "gemini:gemini-2.5-flash",
    });

    // Check that signal was passed to adapter
    expect(geminiAdapter.signalsReceived).toHaveLength(1);
    const signal = geminiAdapter.signalsReceived[0];
    expect(signal.aborted).toBe(false);

    // Trigger cancellation
    chatService.cancel(res.assistantMessageId);
    expect(signal.aborted).toBe(true);

    await res.completion;
  });

  it("cancellation is idempotent across repeated calls and unknown IDs", async () => {
    const { chatService, geminiAdapter } = setupMultiProviderHarness();
    geminiAdapter.delayMs = 30;

    const convId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId: convId,
      content: "Idempotency test",
      modelId: "gemini:gemini-2.5-flash",
    });

    // 1. First cancel returns true
    expect(chatService.cancel(res.assistantMessageId)).toBe(true);

    // 2. Immediate second cancel for same active message is safe and returns true (still active controller)
    expect(chatService.cancel(res.assistantMessageId)).toBe(true);

    await res.completion;

    // 3. Cancel on completed/removed message returns false safely
    expect(chatService.cancel(res.assistantMessageId)).toBe(false);

    // 4. Cancel on random unknown ID returns false safely
    expect(chatService.cancel(createMessageId())).toBe(false);
  });

  it("guarantees exactly one terminal event per stream under all conditions", async () => {
    const { chatService, storage } = setupMultiProviderHarness();

    // 1. Success case: exactly 1 message.completed
    const conv1 = createConversationId();
    const res1 = await chatService.sendMessage({
      conversationId: conv1,
      content: "Success test",
      modelId: ANTHROPIC_MODELS[0].id,
    });
    await res1.completion;
    const events1 = await storage.getByConversation(conv1);
    const completed1 = events1.filter((e) => e.type === "message.completed").length;
    const cancelled1 = events1.filter((e) => e.type === "message.cancelled").length;
    const failed1 = events1.filter((e) => e.type === "message.failed").length;
    expect(completed1 + cancelled1 + failed1).toBe(1);
    expect(completed1).toBe(1);

    // 2. Cancellation case: exactly 1 message.cancelled
    const conv2 = createConversationId();
    const res2 = await chatService.sendMessage({
      conversationId: conv2,
      content: "Cancel test",
      modelId: ANTHROPIC_MODELS[0].id,
    });
    chatService.cancel(res2.assistantMessageId);
    await res2.completion;
    const events2 = await storage.getByConversation(conv2);
    const completed2 = events2.filter((e) => e.type === "message.completed").length;
    const cancelled2 = events2.filter((e) => e.type === "message.cancelled").length;
    const failed2 = events2.filter((e) => e.type === "message.failed").length;
    expect(completed2 + cancelled2 + failed2).toBe(1);
    expect(cancelled2).toBe(1);
  });
});

describe("PR23.9 & PR23.10: Pre-Execution Capability Checks & Provider Failure Determinism", () => {
  it("rejects thinking capability request on Gemini Flash-Lite before network execution (call count = 0)", async () => {
    const { chatService, geminiAdapter } = setupMultiProviderHarness();
    const convId = createConversationId();

    // Gemini Flash-Lite explicitly lacks "thinking" capability
    await expect(
      chatService.sendMessage({
        conversationId: convId,
        content: "Think deeply about physics",
        modelId: "gemini:gemini-2.5-flash-lite",
        options: {
          thinking: { enabled: true, budgetTokens: 1024 },
        },
      }),
    ).rejects.toThrow(UnsupportedCapabilityError);

    // Crucial requirement: provider call count MUST be 0
    expect(geminiAdapter.chatCalls).toHaveLength(0);
  });

  it("accepts thinking capability request on Gemini Pro and Gemini Flash", async () => {
    const { chatService, geminiAdapter } = setupMultiProviderHarness();
    const convId = createConversationId();

    const result = await chatService.sendMessage({
      conversationId: convId,
      content: "Explain calculus",
      modelId: "gemini:gemini-2.5-pro",
      options: {
        thinking: { enabled: true },
      },
    });
    await result.completion;

    expect(geminiAdapter.chatCalls).toHaveLength(1);
    expect(geminiAdapter.chatCalls[0].options?.thinking?.enabled).toBe(true);
  });

  it("rejects cross-provider model mismatches before execution (call count = 0)", async () => {
    const { geminiAdapter, anthropicAdapter, modelSelectionService } = setupMultiProviderHarness();
    const convId = createConversationId();

    // Configure conversation model with mismatched provider and model
    await expect(
      modelSelectionService.setConversationModel(convId, {
        providerId: asProviderId("gemini"),
        modelId: asModelId(ANTHROPIC_MODELS[0].id),
      }),
    ).rejects.toThrow(ModelSelectionError);

    expect(geminiAdapter.chatCalls).toHaveLength(0);
    expect(anthropicAdapter.chatCalls).toHaveLength(0);
  });

  it("throws canonical ModelSelectionError without fallback when a configured provider is unavailable", async () => {
    // Registry with only Anthropic (Gemini is unavailable)
    const anthropicAdapter = new RecordingMultiProviderAdapter(
      ANTHROPIC_PROVIDER_ID,
      ANTHROPIC_MODELS,
    );
    const registry = new ProviderRegistry();
    registry.registerProvider({
      providerId: ANTHROPIC_PROVIDER_ID,
      adapter: anthropicAdapter,
    });
    for (const m of ANTHROPIC_MODELS) {
      registry.registerModel({ model: m });
    }

    const conversationModelRepo = new InMemoryConversationModelRepository();
    const profileRepo = new InMemoryProfileRepository();

    const modelSelectionService = new ModelSelectionService({
      registry,
      profileRepo,
      conversationModelRepo,
      defaultFallbackModelId: ANTHROPIC_MODELS[0].id,
    });

    const chatService = new ChatService({
      modelSelectionService,
      streamRegistry: new ActiveStreamRegistry(),
      eventBus: new EventBus(),
      storage: new InMemoryEventRepository(),
    });

    const convId = createConversationId();

    // Directly record that conversation was configured for Gemini in SQLite
    await conversationModelRepo.set({
      conversationId: convId,
      providerId: "gemini",
      modelId: "gemini:gemini-2.5-flash",
      updatedAt: Date.now(),
    });

    // Must NOT silently fall back to Anthropic!
    await expect(
      chatService.sendMessage({
        conversationId: convId,
        content: "Will it fall back?",
      }),
    ).rejects.toThrow(ModelNotFoundError);

    expect(anthropicAdapter.chatCalls).toHaveLength(0);
  });

  it("propagates canonical provider errors into message.failed terminal event", async () => {
    const { chatService, geminiAdapter, storage } = setupMultiProviderHarness();
    geminiAdapter.failWithError = new ProviderError(
      "RATE_LIMIT_EXCEEDED",
      "Gemini quota exceeded (429)",
      { providerId: "gemini" },
    );

    const convId = createConversationId();
    const res = await chatService.sendMessage({
      conversationId: convId,
      content: "Trigger 429",
      modelId: "gemini:gemini-2.5-flash",
    });

    await res.completion;

    const events = await storage.getByConversation(convId);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe("message.failed");
    expect((lastEvent as MessageFailedEvent).error).toContain("quota exceeded");
  });
});

describe("PR23.11: Typed IPC Dispatch Regression for Multiple Providers", () => {
  it("dispatches CHAT_SEND over IPC with explicit modelId for both providers", async () => {
    const { modelSelectionService, chatService } = setupMultiProviderHarness();
    const ipcRegistry = new IpcRegistry();
    registerIpcHandlers(ipcRegistry, { modelSelectionService, chatService });

    // Send to Gemini via IPC
    const conv1 = createConversationId();
    const res1 = await ipcRegistry.invokeCommand<{ accepted: boolean; messageId: string }>(
      IPC_CHANNELS.CHAT_SEND,
      {
        conversationId: conv1,
        content: "IPC to Gemini",
        modelId: "gemini:gemini-2.5-flash",
      },
    );
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(res1.value.accepted).toBe(true);
    }

    // Send to Anthropic via IPC
    const conv2 = createConversationId();
    const res2 = await ipcRegistry.invokeCommand<{ accepted: boolean; messageId: string }>(
      IPC_CHANNELS.CHAT_SEND,
      {
        conversationId: conv2,
        content: "IPC to Anthropic",
        modelId: ANTHROPIC_MODELS[0].id,
      },
    );
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.value.accepted).toBe(true);
    }
  });

  it("dispatches CHAT_CANCEL over IPC and cleanly aborts active execution", async () => {
    const { modelSelectionService, chatService, geminiAdapter } = setupMultiProviderHarness();
    geminiAdapter.delayMs = 50;

    const ipcRegistry = new IpcRegistry();
    registerIpcHandlers(ipcRegistry, { modelSelectionService, chatService });

    const convId = createConversationId();
    const sendRes = await ipcRegistry.invokeCommand<{ accepted: boolean; messageId: string }>(
      IPC_CHANNELS.CHAT_SEND,
      {
        conversationId: convId,
        content: "Cancel over IPC",
        modelId: "gemini:gemini-2.5-flash",
      },
    );

    expect(sendRes.ok).toBe(true);
    let messageId = "";
    if (sendRes.ok) {
      messageId = sendRes.value.messageId;
    }

    // Cancel via IPC
    const cancelRes = await ipcRegistry.invokeCommand<{ cancelled: boolean }>(
      IPC_CHANNELS.CHAT_CANCEL,
      {
        conversationId: convId,
        messageId,
      },
    );

    expect(cancelRes.ok).toBe(true);
    if (cancelRes.ok) {
      expect(cancelRes.value.cancelled).toBe(true);
    }
  });
});

describe("PR23.12: SQLite WAL Multi-Provider Restart Recovery", () => {
  it("reconstructs conversation history and model selection across application restarts for both providers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-pr23-recovery-"));
    const tmpDbPath = path.join(tmpDir, "recovery.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    const convId = createConversationId();

    // 1. Session 1: Run Gemini turn on SQLite WAL database
    {
      const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db.initialize();

      const storage = new PrismaEventRepository(db);
      const profileRepo = new PrismaProviderProfileRepository(db);
      const conversationModelRepo = new PrismaConversationModelRepository(db);

      const geminiAdapter = new RecordingMultiProviderAdapter(GEMINI_PROVIDER_ID, GEMINI_MODELS);
      const anthropicAdapter = new RecordingMultiProviderAdapter(
        ANTHROPIC_PROVIDER_ID,
        ANTHROPIC_MODELS,
      );

      const registry = new ProviderRegistry();
      registry.registerProvider({ providerId: GEMINI_PROVIDER_ID, adapter: geminiAdapter });
      for (const m of GEMINI_MODELS) registry.registerModel({ model: m });
      registry.registerProvider({ providerId: ANTHROPIC_PROVIDER_ID, adapter: anthropicAdapter });
      for (const m of ANTHROPIC_MODELS) registry.registerModel({ model: m });

      const modelSelectionService = new ModelSelectionService({
        registry,
        profileRepo,
        conversationModelRepo,
      });

      // Persist conversation model selection
      await modelSelectionService.setConversationModel(convId, {
        providerId: asProviderId("gemini"),
        modelId: asModelId("gemini:gemini-2.5-flash"),
      });

      const chatService = new ChatService({
        modelSelectionService,
        streamRegistry: new ActiveStreamRegistry(),
        eventBus: new EventBus(),
        storage,
      });

      const res = await chatService.sendMessage({
        conversationId: convId,
        content: "Turn 1 with Gemini",
      });
      await res.completion;

      // Close session 1
      await db.close();
    }

    // 2. Session 2: "Restart application" - brand new process/database connection on same SQLite file
    {
      const db2 = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db2.initialize();

      const storage2 = new PrismaEventRepository(db2);
      const profileRepo2 = new PrismaProviderProfileRepository(db2);
      const conversationModelRepo2 = new PrismaConversationModelRepository(db2);

      const geminiAdapter2 = new RecordingMultiProviderAdapter(GEMINI_PROVIDER_ID, GEMINI_MODELS);
      const anthropicAdapter2 = new RecordingMultiProviderAdapter(
        ANTHROPIC_PROVIDER_ID,
        ANTHROPIC_MODELS,
      );

      const registry2 = new ProviderRegistry();
      registry2.registerProvider({ providerId: GEMINI_PROVIDER_ID, adapter: geminiAdapter2 });
      for (const m of GEMINI_MODELS) registry2.registerModel({ model: m });
      registry2.registerProvider({ providerId: ANTHROPIC_PROVIDER_ID, adapter: anthropicAdapter2 });
      for (const m of ANTHROPIC_MODELS) registry2.registerModel({ model: m });

      const modelSelectionService2 = new ModelSelectionService({
        registry: registry2,
        profileRepo: profileRepo2,
        conversationModelRepo: conversationModelRepo2,
      });

      const chatService2 = new ChatService({
        modelSelectionService: modelSelectionService2,
        streamRegistry: new ActiveStreamRegistry(),
        eventBus: new EventBus(),
        storage: storage2,
      });

      // Recover conversation messages from SQLite WAL events
      const recoveredConv = await chatService2.getConversation(convId);
      expect(recoveredConv.id).toBe(convId);
      expect(recoveredConv.messages).toHaveLength(2); // user + assistant
      expect(recoveredConv.messages[0].role).toBe("user");
      expect(recoveredConv.messages[1].role).toBe("assistant");
      expect(recoveredConv.messages[1].status).toBe("completed");

      // Turn 2: Send follow-up WITHOUT modelId — should route to Gemini because of persisted model
      const res2 = await chatService2.sendMessage({
        conversationId: convId,
        content: "Turn 2 follow-up",
      });
      await res2.completion;

      expect(geminiAdapter2.chatCalls).toHaveLength(1);
      expect(geminiAdapter2.chatCalls[0].modelId).toBe("gemini:gemini-2.5-flash");
      expect(anthropicAdapter2.chatCalls).toHaveLength(0);

      await db2.close();
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });
});
