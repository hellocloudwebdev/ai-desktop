// PR29.18: apps/desktop — Agent Provider Integration Tests
//
// Both providers drive the same AgentRuntime through the canonical
// ProviderAdapter interface: delta streams accumulate transcripts,
// tool.call.requested streams become ReAct tool calls, and no provider
// receives special-case handling in the runtime.

import { describe, expect, it } from "vitest";
import { EventBus } from "@ai-desktop/agent-runtime";
import {
  createEventId,
  type AIEvent,
  type ChatRequest,
  type ModelDefinition,
  type ModelId,
} from "@ai-desktop/ai-core";
import { createConversationId, createMessageId, createToolCallId, now } from "@ai-desktop/shared";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PROVIDER_ID,
  GEMINI_MODELS,
  GEMINI_PROVIDER_ID,
  type ProviderAdapter,
} from "@ai-desktop/providers";
import type { ProviderConfigError } from "@ai-desktop/providers";
import { ok, type Result } from "@ai-desktop/shared";
import { AgentService } from "../main/agent/index.js";
import { ModelSelectionService } from "../main/chat/model-selection-service.js";
import { DefaultPermissionManager } from "@ai-desktop/permissions";
import {
  InMemoryEventRepository,
  InMemoryProfileRepository,
  InMemoryConversationModelRepository,
} from "./test-helpers.js";
import { ProviderRegistry } from "@ai-desktop/providers";

/** Scripted adapter: each chat() advances one script step (cursor semantics). */
class ScriptedAdapter implements ProviderAdapter {
  readonly providerId;
  private readonly _models: ModelDefinition[];
  private readonly _script: Array<{
    text?: string;
    tool?: { name: string; source: string; runtime: string; input: unknown };
  }>;
  private _cursor = 0;

  constructor(
    providerId: typeof ANTHROPIC_PROVIDER_ID | typeof GEMINI_PROVIDER_ID,
    models: readonly ModelDefinition[],
    script: Array<{
      text?: string;
      tool?: { name: string; source: string; runtime: string; input: unknown };
    }>,
  ) {
    this.providerId = providerId;
    this._models = [...models];
    this._script = script;
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
    const assistantMsgId = createMessageId();
    const step = this._script[Math.min(this._cursor, this._script.length - 1)];
    this._cursor += 1;
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
    } as unknown as AIEvent;
    if (signal?.aborted) return;
    if (step.text) {
      yield {
        eventId: createEventId(),
        conversationId: request.conversationId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "message.delta",
        category: "core",
        messageId: assistantMsgId,
        deltaText: step.text,
      } as unknown as AIEvent;
    }
    if (step.tool) {
      yield {
        eventId: createEventId(),
        conversationId: request.conversationId,
        sequence: 0,
        schemaVersion: 1,
        timestamp: now(),
        type: "tool.call.requested",
        category: "capability",
        toolCallId: createToolCallId(),
        toolName: step.tool.name,
        toolSource: step.tool.source,
        toolRuntime: step.tool.runtime,
        input: step.tool.input,
      } as unknown as AIEvent;
    }
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
    } as unknown as AIEvent;
  }
}

async function createAgentService(adapter: ProviderAdapter) {
  const registry = new ProviderRegistry();
  registry.registerProvider({ providerId: adapter.providerId, adapter });
  for (const m of await adapter.listModels()) {
    registry.registerModel({ model: m });
  }
  const selection = new ModelSelectionService({
    registry,
    profileRepo: new InMemoryProfileRepository(),
    conversationModelRepo: new InMemoryConversationModelRepository(),
  });
  const permissions = new DefaultPermissionManager();
  const bus = new EventBus();
  const storage = new InMemoryEventRepository();
  const published: AIEvent[] = [];
  bus.subscribe(async (event) => {
    published.push(event as AIEvent);
  });
  const service = new AgentService({
    modelSelectionService: selection,
    permissionManager: permissions,
    eventBus: bus,
    storage,
    mcpExecutor: {
      execute: async (toolName, input, options) => ({
        toolCallId: options?.toolCallId ?? createToolCallId(),
        toolName,
        result: `ok:${toolName}`,
        isError: false,
        timestamp: now(),
      }),
    },
  });
  return { service, published, permissions };
}

describe("apps/desktop: Agent provider integration (PR29.18)", () => {
  it("runs an Anthropic-backed agent task through the canonical interface", async () => {
    const adapter = new ScriptedAdapter(ANTHROPIC_PROVIDER_ID, ANTHROPIC_MODELS, [
      { text: "Anthropic says hi." },
    ]);
    const { service, published } = await createAgentService(adapter);

    const result = await service.startTask({
      conversationId: createConversationId(),
      goal: "Greet",
      modelId: ANTHROPIC_MODELS[0].id,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.summary).toContain("Anthropic says hi.");
    }
    expect(published.map((e) => e.type)).toContain("task.completed");
  });

  it("runs a Gemini-backed agent task through the same canonical interface", async () => {
    const adapter = new ScriptedAdapter(GEMINI_PROVIDER_ID, GEMINI_MODELS, [
      { text: "Gemini says hi." },
    ]);
    const { service, published } = await createAgentService(adapter);

    const result = await service.startTask({
      conversationId: createConversationId(),
      goal: "Greet",
      modelId: GEMINI_MODELS[0].id,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.summary).toContain("Gemini says hi.");
    }
    expect(published.map((e) => e.type)).toContain("task.completed");
  });

  it("routes provider-requested tools through approval + universal tool lifecycle", async () => {
    const adapter = new ScriptedAdapter(ANTHROPIC_PROVIDER_ID, ANTHROPIC_MODELS, [
      {
        text: "Checking. ",
        tool: {
          name: "mcp:weather/get",
          source: "mcp",
          runtime: "mcp_protocol",
          input: { city: "Oslo" },
        },
      },
      { text: "Done after tool." },
    ]);
    const { service, published, permissions } = await createAgentService(adapter);

    // No policy exists yet: the tool request blocks without executing anything.
    const blocked = await service.startTask({
      conversationId: createConversationId(),
      goal: "Weather check",
      modelId: ANTHROPIC_MODELS[0].id,
    });
    expect(blocked.status).toBe("failed");
    const taskId = service.listTasks()[0];
    expect(service.getTaskStatus(taskId)).toBe("blocked");
    expect(published.map((e) => e.type)).toContain("task.blocked");

    // Genuine approval flow: resolve the pending request for the session, then resume.
    const pending = permissions.listPendingRequests();
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const resolved = await permissions.resolve({
      requestId: pending[0].id,
      decision: "granted",
      mode: "allow_session",
    });
    expect(resolved).toBe(true);

    const resumed = await service.resumeTask(taskId);
    expect(resumed?.status).toBe("completed");
    const types = published.map((e) => e.type);
    expect(types).toContain("tool.call.started");
    expect(types).toContain("tool.call.completed");
    if (resumed?.status === "completed") {
      expect(resumed.summary).toContain("Done after tool.");
    }
  });

  it("rejects unknown model ids explicitly (no silent provider fallback)", async () => {
    const adapter = new ScriptedAdapter(ANTHROPIC_PROVIDER_ID, ANTHROPIC_MODELS, [{ text: "Hi." }]);
    const { service } = await createAgentService(adapter);

    const result = await service.startTask({
      conversationId: createConversationId(),
      goal: "Bad model",
      modelId: "gemini:does-not-exist",
    });

    // Model selection throws; the runtime records a clean failure, never a fallback.
    expect(result.status).toBe("failed");
  });
});
