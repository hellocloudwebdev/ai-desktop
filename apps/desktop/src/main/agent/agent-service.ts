// PR29.16: apps/desktop — AgentService (Desktop Agent Runtime Wiring)
//
// Invariants:
//   1. The AgentRuntime stays orchestration-only: this service adapts the proven
//      desktop foundations (ModelSelectionService, ToolRegistry/SkillToolRegistry,
//      PermissionManager, MemoryService, EventBus/storage) to the runtime's
//      injected boundaries (ModelInvoker, ToolInvoker, MemoryProvider,
//      PermissionGateway, EventSink).
//   2. Provider-neutral: model turns resolve through ModelSelectionService and
//      consume adapter.chat() canonical AIEvent streams; tool.call.requested
//      events are the ReAct signal — no invented JSON function-call protocol.
//   3. Tool routing by canonical source prefix: mcp:* -> McpToolExecutor,
//      skill:* -> SkillToolExecutor, anything else -> MCP registry lookup.
//   4. Permission stays external: the gateway reports requires_user/deny as
//      blocked; it never approves on the model's behalf.
//   5. Task events flow through EventSink -> EventBus -> storage (persistence
//      before delivery), so projectTaskGraph can replay any finished run.
//   6. ChatService coexistence: simple chat is untouched; this is an additional
//      explicit orchestration mode (agent:start), never a replacement.

import { EventBus, AgentRuntime } from "@ai-desktop/agent-runtime";
import type {
  AgentTaskResult,
  AgentTaskStatus,
  EventSink,
  MemoryProvider,
  ModelInvoker,
  ModelTurnOutcome,
  PermissionGateway,
  RequestedToolCall,
  RunTaskInput,
  ToolInvoker,
} from "@ai-desktop/agent-runtime";
import {
  asModelId,
  type AIEvent,
  type ChatMessageInput,
  type ChatRequest,
  type ConversationId,
  type ModelId,
  type TaskId,
  type TaskNodeId,
  type ToolCallId,
  type ToolResult,
} from "@ai-desktop/ai-core";
import { createConversationId, createMessageId, createToolCallId, now } from "@ai-desktop/shared";
import type { ProviderAdapter } from "@ai-desktop/providers";
import type { MemoryService } from "@ai-desktop/memory";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { ModelSelectionService } from "../chat/index.js";
import type { ActiveStreamRegistry } from "../chat/index.js";
import type { EventRepository } from "@ai-desktop/storage";

export interface DesktopModelAdapterDeps {
  readonly modelSelectionService: ModelSelectionService;
}

/**
 * Provider-neutral ModelInvoker: resolves the model route per conversation,
 * streams adapter.chat() canonical events, accumulates the transcript from
 * message.delta parts, and collects tool.call.requested events as the
 * ReAct tool-call signal.
 */
export class DesktopModelInvoker implements ModelInvoker {
  private readonly _modelSelection: ModelSelectionService;

  constructor(deps: DesktopModelAdapterDeps) {
    this._modelSelection = deps.modelSelectionService;
  }

  async chat(
    request: ChatRequest,
    nodeMessages: readonly ChatMessageInput[],
    signal?: AbortSignal,
  ): Promise<ModelTurnOutcome> {
    const route = await this._modelSelection.resolveForConversation(
      request.conversationId,
      request.modelId,
    );
    const adapter: ProviderAdapter = route.adapter;
    const fullRequest: ChatRequest = {
      ...request,
      modelId: route.model.id,
      messages: [...request.messages, ...nodeMessages],
    };

    let transcript = "";
    const toolCalls: RequestedToolCall[] = [];
    const stream = adapter.chat(fullRequest, signal);
    for await (const event of stream) {
      if (signal?.aborted) break;
      if (event.type === "message.delta") {
        const deltaText = (event as { deltaText?: unknown }).deltaText;
        if (typeof deltaText === "string") transcript += deltaText;
      } else if (event.type === "message.completed") {
        const content = (event as { content?: unknown }).content;
        if (typeof content === "string" && !transcript) transcript = content;
      } else if (event.type === "tool.call.requested") {
        const requested = event as unknown as {
          toolCallId: ToolCallId;
          toolName: string;
          toolSource: string;
          toolRuntime: string;
          input: unknown;
        };
        toolCalls.push({
          toolCallId: requested.toolCallId,
          toolName: requested.toolName,
          toolSource: String(requested.toolSource ?? "builtin"),
          toolRuntime: String(requested.toolRuntime ?? "in_process"),
          input: requested.input,
        });
      }
    }
    return { transcript, toolCalls, completed: toolCalls.length === 0 };
  }
}

export interface DesktopToolRouterDeps {
  readonly permissionManager: PermissionManager;
  readonly mcpExecutor?: {
    execute(
      toolName: string,
      input: unknown,
      options?: { toolCallId?: ToolCallId },
    ): Promise<ToolResult>;
  };
  readonly skillExecutor?: {
    execute(
      toolName: string,
      input: unknown,
      options?: { toolCallId?: ToolCallId },
    ): Promise<ToolResult>;
  };
}

/**
 * Universal ToolInvoker: routes by canonical tool id prefix to the MCP or
 * Skill executor. Both executors already enforce validation -> permission ->
 * execution internally; the runtime's own permission gateway runs first as
 * the external blocked check.
 */
export class DesktopToolRouter implements ToolInvoker {
  private readonly _permissionManager: PermissionManager;
  private readonly _mcpExecutor?: DesktopToolRouterDeps["mcpExecutor"];
  private readonly _skillExecutor?: DesktopToolRouterDeps["skillExecutor"];

  constructor(deps: DesktopToolRouterDeps) {
    this._permissionManager = deps.permissionManager;
    this._mcpExecutor = deps.mcpExecutor;
    this._skillExecutor = deps.skillExecutor;
    void this._permissionManager;
  }

  async invoke(
    toolName: string,
    input: unknown,
    context: { toolCallId: ToolCallId; projectId?: string; conversationId: ConversationId },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) {
      return {
        toolCallId: context.toolCallId,
        toolName,
        result: null,
        isError: true,
        error: "Tool call cancelled",
        timestamp: now(),
      } as ToolResult;
    }
    const executor = toolName.startsWith("skill:") ? this._skillExecutor : this._mcpExecutor;
    if (!executor) {
      return {
        toolCallId: context.toolCallId,
        toolName,
        result: null,
        isError: true,
        error: `No executor registered for tool "${toolName}"`,
        timestamp: now(),
      } as ToolResult;
    }
    return executor.execute(toolName, input, { toolCallId: context.toolCallId });
  }
}

export interface DesktopMemoryProviderDeps {
  readonly memoryService?: MemoryService;
}

/**
 * MemoryProvider over the PR28 MemoryService: project-scoped bounded context,
 * formatted with the canonical formatter. Absent service degrades to empty.
 */
export class DesktopMemoryProvider implements MemoryProvider {
  private readonly _memoryService?: MemoryService;

  constructor(deps: DesktopMemoryProviderDeps) {
    this._memoryService = deps.memoryService;
  }

  async retrieveForTask(goal: string, projectId?: string): Promise<string> {
    if (!this._memoryService) return "";
    const section = await this._memoryService.buildMemoryContext({ projectId, query: goal });
    return this._memoryService.formatMemoryContext(section);
  }
}

export interface DesktopPermissionGatewayDeps {
  readonly permissionManager: PermissionManager;
}

/**
 * PermissionGateway over the PR24 PermissionManager: any non-allow decision
 * (deny or requires_user) surfaces as blocked. Model text never approves.
 */
export class DesktopPermissionGateway implements PermissionGateway {
  private readonly _permissionManager: PermissionManager;

  constructor(deps: DesktopPermissionGatewayDeps) {
    this._permissionManager = deps.permissionManager;
  }

  async isBlocked(toolName: string, projectId?: string, toolCallId?: ToolCallId): Promise<boolean> {
    const decision = await this._permissionManager.check(
      {
        capability: "tools.use",
        action: "execute",
        resource: toolName,
        scope: projectId ? "project" : "session",
        risk: "medium",
        relatedToolCallIds: [toolCallId ?? createToolCallId()],
      },
      { projectId, batchId: `agent:${toolName}` },
    );
    return decision.kind !== "allow";
  }
}

export interface DesktopEventSinkDeps {
  readonly eventBus: EventBus;
  readonly storage: EventRepository;
}

/**
 * EventSink -> EventBus -> storage: persists every task event before delivery
 * so replay (projectTaskGraph) sees the authoritative history.
 */
export class DesktopEventSink implements EventSink {
  private readonly _eventBus: EventBus;
  private readonly _storage: EventRepository;

  constructor(deps: DesktopEventSinkDeps) {
    this._eventBus = deps.eventBus;
    this._storage = deps.storage;
  }

  async publish(event: Readonly<AIEvent>): Promise<void> {
    await this._storage.append(event as AIEvent);
    await this._eventBus.publish(event as AIEvent);
  }
}

export interface AgentServiceDeps {
  readonly modelSelectionService: ModelSelectionService;
  readonly permissionManager: PermissionManager;
  readonly memoryService?: MemoryService;
  readonly eventBus: EventBus;
  readonly storage: EventRepository;
  readonly streamRegistry?: ActiveStreamRegistry;
  readonly mcpExecutor?: DesktopToolRouterDeps["mcpExecutor"];
  readonly skillExecutor?: DesktopToolRouterDeps["skillExecutor"];
  readonly maxNodeIterations?: number;
  readonly defaultModelId?: ModelId;
}

/**
 * Desktop AgentService: owns one AgentRuntime wired to the proven desktop
 * foundations. ChatService coexistence is structural — this service never
 * touches conversation message flows; it only drives agent task runs whose
 * task.* events share the same EventBus/storage substrate.
 */
export class AgentService {
  private readonly _runtime: AgentRuntime;

  constructor(deps: AgentServiceDeps) {
    const eventSink = new DesktopEventSink({ eventBus: deps.eventBus, storage: deps.storage });
    this._runtime = new AgentRuntime({
      modelInvoker: new DesktopModelInvoker({ modelSelectionService: deps.modelSelectionService }),
      toolInvoker: new DesktopToolRouter({
        permissionManager: deps.permissionManager,
        mcpExecutor: deps.mcpExecutor,
        skillExecutor: deps.skillExecutor,
      }),
      eventSink,
      memoryProvider: new DesktopMemoryProvider({ memoryService: deps.memoryService }),
      permissionGateway: new DesktopPermissionGateway({
        permissionManager: deps.permissionManager,
      }),
      maxNodeIterations: deps.maxNodeIterations,
      defaultModelId: deps.defaultModelId,
    });
  }

  get runtime(): AgentRuntime {
    return this._runtime;
  }

  async startTask(input: {
    conversationId?: ConversationId;
    goal: string;
    projectId?: string;
    modelId?: string;
    systemPrompt?: string;
    maxNodeIterations?: number;
  }): Promise<AgentTaskResult> {
    const runInput: RunTaskInput = {
      conversationId: input.conversationId ?? createConversationId(),
      goal: input.goal,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.modelId ? { modelId: asModelId(input.modelId) } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.maxNodeIterations ? { maxNodeIterations: input.maxNodeIterations } : {}),
    };
    return this._runtime.runTask(runInput);
  }

  cancelTask(taskId: TaskId, reason?: string): boolean {
    return this._runtime.cancelTask(taskId, reason);
  }

  async resumeTask(taskId: TaskId): Promise<AgentTaskResult | null> {
    return this._runtime.resumeTask(taskId);
  }

  getTaskStatus(taskId: TaskId): AgentTaskStatus | undefined {
    return this._runtime.getTaskStatus(taskId);
  }

  listTasks(): TaskId[] {
    return this._runtime.listTasks();
  }

  getTaskGraph(
    taskId: TaskId,
  ): { nodes: Array<{ id: TaskNodeId; goal: string; status: string }> } | undefined {
    const graph = this._runtime.getTaskGraph(taskId);
    if (!graph) return undefined;
    const snap = graph.snapshot();
    return {
      nodes: [...snap.nodes.values()].map((n) => ({ id: n.id, goal: n.goal, status: n.status })),
    };
  }

  // Test-convenience id generation keeps suites honest about branded ids.
  static createIds(): { toolCallId: string; messageId: string } {
    return {
      toolCallId: createToolCallId(),
      messageId: createMessageId(),
    };
  }
}
