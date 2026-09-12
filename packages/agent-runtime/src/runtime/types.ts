// PR29.2 & PR29.5: packages/agent-runtime — Runtime Context, Node Actions & Boundaries
//
// Invariants:
//   1. AgentRuntimeContext is runtime-neutral: taskId, conversationId, optional projectId, AbortSignal.
//   2. The runtime depends on abstractions only (ModelInvoker, ToolInvoker, MemoryProvider,
//      PermissionGateway, EventSink) — never on Electron, Prisma, Docker, or provider/MCP SDKs.
//   3. NodeAction vocabulary is locked: final-answer | tool-call | subtask | replan | blocked | failure.
//   4. Task/node statuses follow the canonical lifecycle: pending/active/blocked/completed/failed/cancelled.
//   5. Retry policy: maxAutoRetries = 1 for eligible transient technical failures only.

import type {
  AIEvent,
  ChatMessageInput,
  ChatRequest,
  ConversationId,
  ModelId,
  TaskId,
  TaskNodeId,
  TaskNodeStatus,
  ToolCallId,
  ToolDefinition,
  ToolResult,
} from "@ai-desktop/ai-core";

/** Canonical node statuses used by the AgentRuntime lifecycle. */
export const AGENT_NODE_STATUSES = [
  "pending",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentNodeStatus = (typeof AGENT_NODE_STATUSES)[number];

/** Canonical task terminal + active statuses. */
export const AGENT_TASK_STATUSES = [
  "pending",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

/** Runtime-neutral execution context for a single task run. */
export interface AgentRuntimeContext {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly projectId?: string;
  readonly signal: AbortSignal;
}

/** Input for starting a new agent task run. */
export interface RunTaskInput {
  readonly conversationId: ConversationId;
  readonly goal: string;
  readonly projectId?: string;
  readonly modelId?: ModelId;
  readonly systemPrompt?: string;
  readonly maxNodeIterations?: number;
}

/** Terminal outcome of a task run. Exactly one of completed/failed/cancelled. */
export type AgentTaskResult =
  | { readonly status: "completed"; readonly taskId: TaskId; readonly summary: string }
  | { readonly status: "failed"; readonly taskId: TaskId; readonly error: string }
  | { readonly status: "cancelled"; readonly taskId: TaskId; readonly reason?: string };

/** A tool call requested by the model during a node ReAct turn. */
export interface RequestedToolCall {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly toolSource: string;
  readonly toolRuntime: string;
  readonly input: unknown;
}

/** Outcome of one ReAct model turn: transcript plus any requested tool calls. */
export interface ModelTurnOutcome {
  readonly transcript: string;
  readonly toolCalls: readonly RequestedToolCall[];
  readonly completed: boolean;
}

/** Model invocation boundary: provider-neutral chat through an injected invoker. */
export interface ModelInvoker {
  chat(
    request: ChatRequest,
    nodeMessages: readonly ChatMessageInput[],
    signal?: AbortSignal,
  ): Promise<ModelTurnOutcome>;
}

/** Tool invocation boundary: every tool converges on this lifecycle. */
export interface ToolInvoker {
  invoke(
    toolName: string,
    input: unknown,
    context: { toolCallId: ToolCallId; projectId?: string; conversationId: ConversationId },
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

/** Memory retrieval boundary: project-scoped, bounded, sensitivity-filtered. */
export interface MemoryProvider {
  retrieveForTask(goal: string, projectId?: string): Promise<string>;
}

/** Permission gateway boundary: external PermissionManager decision stays authoritative. */
export interface PermissionGateway {
  isBlocked(toolName: string, projectId?: string, toolCallId?: ToolCallId): Promise<boolean>;
}

/** Event emission boundary: task events flow to EventBus/storage. */
export interface EventSink {
  publish(event: Readonly<AIEvent>): Promise<void>;
}

/** A single node definition supplied at task creation. */
export interface TaskNodeSpec {
  readonly goal: string;
  readonly dependsOn?: readonly TaskNodeId[];
  readonly parentId?: TaskNodeId;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A plan revision applied to a running graph. */
export interface PlanRevision {
  readonly addedNodes?: readonly (TaskNodeSpec & { id?: TaskNodeId })[];
  readonly removedNodeIds?: readonly TaskNodeId[];
  readonly reason?: string;
}

/** Maximum automatic retries for eligible transient technical failures. */
export const MAX_AUTO_RETRIES = 1;

/** Model-facing tool catalog entry (never exposes executor internals). */
export type { ToolDefinition };
export type { TaskNodeStatus };
