// PR29.6–PR29.16: packages/agent-runtime — AgentRuntime Orchestrator
//
// Invariants:
//   1. Hybrid design: TaskGraph is the durable skeleton; ReAct runs inside each node.
//   2. Provider-neutral: model invocation flows through the injected ModelInvoker only.
//   3. Tool invocations flow through the injected ToolInvoker (universal lifecycle).
//   4. Permission is external: requires_user/tool-denied puts the node in blocked state.
//   5. Cancellation propagates downward only (node -> tool -> execution); siblings survive.
//   6. Retry: maxAutoRetries = 1 for eligible transient technical failures only.
//   7. Every task ends in exactly one terminal state: completed/failed/cancelled.
//   8. Events (task.*) are emitted through the injected EventSink (EventBus -> storage).
//   9. Memory flows through the injected MemoryProvider with projectId propagation.
//  10. ChatService coexistence: this runtime is an additional orchestration mode,
//      never a replacement for simple chat.

import {
  createEventId,
  createTaskNodeId,
  type AIEvent,
  type ChatMessageInput,
  type ConversationId,
  type ModelId,
  type TaskId,
  type TaskNodeId,
} from "@ai-desktop/ai-core";
import {
  createConversationId,
  createMessageId,
  createTaskId,
  createToolCallId,
  now,
} from "@ai-desktop/shared";
import { TaskGraph } from "./task-graph.js";
import type {
  AgentRuntimeContext,
  AgentTaskResult,
  AgentTaskStatus,
  EventSink,
  MemoryProvider,
  ModelInvoker,
  PermissionGateway,
  PlanRevision,
  RequestedToolCall,
  RunTaskInput,
  ToolInvoker,
} from "./types.js";
import { MAX_AUTO_RETRIES } from "./types.js";

export interface AgentRuntimeDependencies {
  readonly modelInvoker: ModelInvoker;
  readonly toolInvoker: ToolInvoker;
  readonly eventSink: EventSink;
  readonly memoryProvider?: MemoryProvider;
  readonly permissionGateway?: PermissionGateway;
  readonly maxNodeIterations?: number;
  readonly defaultModelId?: ModelId;
}

interface ActiveTask {
  readonly graph: TaskGraph;
  readonly context: AgentRuntimeContext;
  readonly conversationId: ConversationId;
  readonly projectId?: string;
  readonly goal: string;
  readonly modelId?: ModelId;
  readonly systemPrompt?: string;
  status: AgentTaskStatus;
  sequence: number;
  controller: AbortController;
  readonly nodeControllers: Map<TaskNodeId, AbortController>;
}

const TRANSIENT_MESSAGE_PATTERN =
  /(timeout|timed out|temporar|transient|rate.?limit|429|502|503|504|econnreset|socket hang up|network)/i;

function isTransientTechnicalFailure(message: string): boolean {
  return TRANSIENT_MESSAGE_PATTERN.test(message);
}

function isPermissionDenial(message: string): boolean {
  return /(permission denied|denied by|requires user|forbidden|unauthorized)/i.test(message);
}

export class AgentRuntime {
  private readonly _modelInvoker: ModelInvoker;
  private readonly _toolInvoker: ToolInvoker;
  private readonly _eventSink: EventSink;
  private readonly _memoryProvider?: MemoryProvider;
  private readonly _permissionGateway?: PermissionGateway;
  private readonly _maxNodeIterations: number;
  private readonly _defaultModelId?: ModelId;
  private readonly _tasks = new Map<TaskId, ActiveTask>();

  constructor(deps: AgentRuntimeDependencies) {
    this._modelInvoker = deps.modelInvoker;
    this._toolInvoker = deps.toolInvoker;
    this._eventSink = deps.eventSink;
    this._memoryProvider = deps.memoryProvider;
    this._permissionGateway = deps.permissionGateway;
    this._maxNodeIterations = deps.maxNodeIterations ?? 12;
    this._defaultModelId = deps.defaultModelId;
  }

  listTasks(): TaskId[] {
    return [...this._tasks.keys()];
  }

  getTaskStatus(taskId: TaskId): AgentTaskStatus | undefined {
    return this._tasks.get(taskId)?.status;
  }

  getTaskGraph(taskId: TaskId): TaskGraph | undefined {
    return this._tasks.get(taskId)?.graph;
  }

  /**
   * Explicit runtime entry point: runs a task to a single terminal state.
   */
  async runTask(input: RunTaskInput, signal?: AbortSignal): Promise<AgentTaskResult> {
    const taskId = createTaskId();
    const conversationId = input.conversationId ?? createConversationId();
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    const graph = new TaskGraph(taskId, [{ goal: input.goal }]);
    const context: AgentRuntimeContext = {
      taskId,
      conversationId,
      projectId: input.projectId,
      signal: controller.signal,
    };
    const task: ActiveTask = {
      graph,
      context,
      conversationId,
      projectId: input.projectId,
      goal: input.goal,
      modelId: input.modelId ?? this._defaultModelId,
      systemPrompt: input.systemPrompt,
      status: "pending",
      sequence: 0,
      controller,
      nodeControllers: new Map(),
    };
    this._tasks.set(taskId, task);

    try {
      await this._emitTaskCreated(task);
      task.status = "active";
      await this._emitTaskStarted(task);
      // The initial plan is itself a plan revision: every node must appear as
      // task.subtask.created so event replay (projectTaskGraph) rebuilds the
      // same graph the live runtime drove.
      for (const [, initialNode] of task.graph.snapshot().nodes) {
        await this._emitSubtaskCreated(
          task,
          initialNode.id,
          initialNode.goal,
          initialNode.dependsOn,
        );
      }

      return await this._settleTask(task, input.maxNodeIterations ?? this._maxNodeIterations);
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        task.status = "cancelled";
        await this._emitTaskCancelled(task, err instanceof Error ? err.message : String(err));
        return { status: "cancelled", taskId, reason: "Task cancelled" };
      }
      task.status = "failed";
      const error = err instanceof Error ? err.message : String(err);
      await this._emitTaskFailed(task, error);
      return { status: "failed", taskId, error };
    } finally {
      task.nodeControllers.clear();
    }
  }

  /**
   * Settles a driven graph to exactly one terminal result (completed/failed/cancelled).
   */
  private async _settleTask(task: ActiveTask, maxIterations: number): Promise<AgentTaskResult> {
    const taskId = task.context.taskId;
    const controller = task.controller;
    const outcome = await this._driveGraph(task, maxIterations);

    if (controller.signal.aborted) {
      task.status = "cancelled";
      await this._emitTaskCancelled(task, "Task cancelled");
      return { status: "cancelled", taskId, reason: "Task cancelled" };
    }

    if (outcome === "completed") {
      task.status = "completed";
      const summary = this._summarize(task);
      await this._emitTaskCompleted(task);
      return { status: "completed", taskId, summary };
    }

    if (outcome === "blocked") {
      task.status = "blocked";
      return { status: "failed", taskId, error: "Task blocked awaiting approval" };
    }

    task.status = "failed";
    const error = this._collectFailure(task);
    await this._emitTaskFailed(task, error);
    return { status: "failed", taskId, error };
  }

  /**
   * Resumes a blocked task after external approval: blocked -> active, no duplicate execution.
   * Reuses _settleTask so terminal emission stays exactly-once.
   */
  async resumeTask(taskId: TaskId): Promise<AgentTaskResult | null> {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "blocked") return null;
    task.status = "active";
    // Re-drive only nodes still pending/blocked; completed work is never re-executed.
    for (const [, node] of task.graph.snapshot().nodes) {
      if (node.status === "blocked") {
        task.graph.setNodeStatus(node.id, "pending");
      }
    }
    try {
      return await this._settleTask(task, this._maxNodeIterations);
    } finally {
      task.nodeControllers.clear();
    }
  }

  /**
   * Cancels a running task. Downward-only: the task's own signal aborts;
   * no sibling or parent task is touched (each task owns its controller).
   */
  cancelTask(taskId: TaskId, reason?: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return false;
    }
    // Downward propagation: abort every active node controller, then the task controller.
    for (const [, nodeController] of task.nodeControllers) {
      try {
        nodeController.abort(reason ?? "Task cancelled");
      } catch {
        // ignore
      }
    }
    try {
      task.controller.abort(reason ?? "Task cancelled");
    } catch {
      // ignore
    }
    return true;
  }

  /**
   * Applies a plan revision to a running graph and emits task.replan.
   */
  async replan(taskId: TaskId, revision: PlanRevision): Promise<boolean> {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    const addedIds: TaskNodeId[] = [];
    if (revision.addedNodes) {
      for (const spec of revision.addedNodes) {
        const node = task.graph.addNode(spec);
        addedIds.push(node.id);
        await this._emitSubtaskCreated(task, node.id, node.goal, node.dependsOn);
      }
    }
    if (revision.removedNodeIds) {
      for (const id of revision.removedNodeIds) {
        task.graph.removeNode(id);
      }
    }
    await this._emitTaskReplan(task, revision.reason, addedIds, revision.removedNodeIds ?? []);
    return true;
  }

  // -------------------------------------------------------------------------
  // Graph driver
  // -------------------------------------------------------------------------

  private async _driveGraph(
    task: ActiveTask,
    maxIterations: number,
  ): Promise<"completed" | "failed" | "blocked"> {
    let iterations = 0;
    while (iterations < maxIterations) {
      iterations += 1;
      if (task.controller.signal.aborted) return "failed";

      const ready = task.graph.readyNodes();
      if (ready.length === 0) {
        if (task.graph.allTerminal()) {
          return task.graph.hasFailed() ? "failed" : "completed";
        }
        // No ready nodes but graph not terminal: nodes are blocked or waiting.
        const snap = task.graph.snapshot();
        const blockedExists = [...snap.nodes.values()].some((n) => n.status === "blocked");
        if (blockedExists) return "blocked";
        // Deadlock safety: active nodes with no progress path fail deterministically.
        return "failed";
      }

      // Execute ready nodes sequentially for deterministic ordering.
      for (const node of ready) {
        if (task.controller.signal.aborted) return "failed";
        const nodeOutcome = await this._runNode(task, node.id);
        if (nodeOutcome === "blocked") return "blocked";
        if (nodeOutcome === "cancelled") return "failed";
        if (nodeOutcome === "failed" && this._shouldFailFast(task)) {
          return "failed";
        }
      }

      if (task.graph.allTerminal()) {
        return task.graph.hasFailed() ? "failed" : "completed";
      }
    }
    return task.graph.hasFailed() ? "failed" : "completed";
  }

  private _shouldFailFast(task: ActiveTask): boolean {
    // A failed node fails the task fast only when no other pending/active work can proceed
    // and no planner revision has rescued it. Dependents simply never become ready.
    const snap = task.graph.snapshot();
    for (const [, node] of snap.nodes) {
      if (node.status === "pending" || node.status === "active") return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Node ReAct loop
  // -------------------------------------------------------------------------

  private async _runNode(
    task: ActiveTask,
    nodeId: TaskNodeId,
  ): Promise<"completed" | "failed" | "blocked" | "cancelled"> {
    const node = task.graph.getNode(nodeId);
    if (!node) return "failed";

    const nodeController = new AbortController();
    task.nodeControllers.set(nodeId, nodeController);
    const forwardAbort = () => {
      try {
        nodeController.abort(task.controller.signal.reason);
      } catch {
        // ignore
      }
    };
    if (task.controller.signal.aborted) {
      task.nodeControllers.delete(nodeId);
      return "cancelled";
    }
    task.controller.signal.addEventListener("abort", forwardAbort, { once: true });

    try {
      task.graph.setNodeStatus(nodeId, "active");
      await this._emitNodeStarted(task, nodeId);

      // Memory retrieval scoped to the task project (PR29.15)
      let memoryText = "";
      if (this._memoryProvider) {
        try {
          memoryText = await this._memoryProvider.retrieveForTask(node.goal, task.projectId);
        } catch {
          memoryText = "";
        }
      }

      let transcript = "";
      let pendingReplay: RequestedToolCall[] | null = null;
      // Re-hydrate transcript from any prior partial progress recorded on the node,
      // so a resumed node continues where it left off instead of restarting.
      // A blocked node additionally replays its exact pending tool calls first.
      const priorResult = node.result;
      if (typeof priorResult === "string" && priorResult) {
        try {
          const parsed = JSON.parse(priorResult) as {
            pendingToolCalls?: RequestedToolCall[];
            transcript?: string;
          };
          if (Array.isArray(parsed.pendingToolCalls) && parsed.pendingToolCalls.length > 0) {
            pendingReplay = parsed.pendingToolCalls;
            transcript = typeof parsed.transcript === "string" ? parsed.transcript : "";
          } else {
            transcript = priorResult;
          }
        } catch {
          transcript = priorResult;
        }
      }
      // ReAct iterations inside the node
      for (let turn = 0; turn < this._maxNodeIterations; turn++) {
        if (nodeController.signal.aborted || task.controller.signal.aborted) {
          task.graph.setNodeStatus(nodeId, "cancelled");
          return "cancelled";
        }

        // On the first resumed turn, replay the exact blocked tool calls instead of
        // asking the model again (prevents duplicate/drifted tool requests).
        let turnOutcome: { transcript: string; toolCalls: readonly RequestedToolCall[] };
        if (pendingReplay) {
          turnOutcome = { transcript: "", toolCalls: pendingReplay };
          pendingReplay = null;
        } else {
          const modelOutcome = await this._modelTurn(
            task,
            nodeId,
            transcript,
            memoryText,
            nodeController.signal,
          );
          turnOutcome = { transcript: modelOutcome.transcript, toolCalls: modelOutcome.toolCalls };
        }

        if (turnOutcome.transcript) {
          transcript = transcript
            ? `${transcript}\n${turnOutcome.transcript}`
            : turnOutcome.transcript;
        }
        // Checkpoint partial progress so a later resume continues instead of restarting.
        task.graph.setNodeResult(nodeId, transcript);

        if (turnOutcome.toolCalls.length === 0) {
          // No tool requested: node completes with the transcript as result.
          task.graph.setNodeResult(nodeId, transcript || "(no output)");
          task.graph.setNodeStatus(nodeId, "completed");
          await this._emitNodeCompleted(task, nodeId, transcript || "(no output)");
          return "completed";
        }

        // Execute requested tools through the universal lifecycle boundary.
        for (const toolCall of turnOutcome.toolCalls) {
          if (nodeController.signal.aborted || task.controller.signal.aborted) {
            task.graph.setNodeStatus(nodeId, "cancelled");
            return "cancelled";
          }

          // Checkpoint transcript before the tool call so a block/resume
          // replays the model turn instead of re-requesting the tool blindly.
          task.graph.setNodeResult(nodeId, transcript);

          const toolOutcome = await this._executeToolCall(
            task,
            nodeId,
            toolCall,
            nodeController.signal,
          );
          if (toolOutcome === "blocked") {
            task.graph.setNodeStatus(nodeId, "blocked");
            await this._emitTaskBlocked(
              task,
              nodeId,
              `Permission approval required for tool "${toolCall.toolName}"`,
            );
            // Persist the pending tool call so resume replays this exact turn.
            task.graph.setNodeResult(
              nodeId,
              JSON.stringify({
                pendingToolCalls: [
                  {
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    toolSource: toolCall.toolSource,
                    toolRuntime: toolCall.toolRuntime,
                    input: toolCall.input,
                  },
                ],
                transcript,
              }),
            );
            return "blocked";
          }
          if (toolOutcome === "cancelled") {
            task.graph.setNodeStatus(nodeId, "cancelled");
            return "cancelled";
          }
          if (toolOutcome === "failed-transient" || toolOutcome === "failed") {
            // Record tool output into transcript for model continuation; node itself
            // continues unless the failure is terminal for this node.
            transcript = transcript
              ? `${transcript}\n[Tool ${toolCall.toolName} ${toolOutcome === "failed-transient" ? "retried" : "failed"}]`
              : `[Tool ${toolCall.toolName} ${toolOutcome === "failed-transient" ? "retried" : "failed"}]`;
            if (toolOutcome === "failed") {
              // Non-transient tool failure marks node failed (planner may replan/skip).
              task.graph.setNodeError(nodeId, `Tool "${toolCall.toolName}" failed`);
              task.graph.setNodeStatus(nodeId, "failed");
              await this._emitNodeFailed(task, nodeId, `Tool "${toolCall.toolName}" failed`);
              return "failed";
            }
          } else {
            transcript = transcript
              ? `${transcript}\n[Tool ${toolCall.toolName} result: ${toolOutcome}]`
              : `[Tool ${toolCall.toolName} result: ${toolOutcome}]`;
          }
        }
      }

      // Iteration budget exhausted: complete with accumulated transcript.
      task.graph.setNodeResult(nodeId, transcript || "(no output)");
      task.graph.setNodeStatus(nodeId, "completed");
      await this._emitNodeCompleted(task, nodeId, transcript || "(no output)");
      return "completed";
    } catch (err: unknown) {
      if (nodeController.signal.aborted || task.controller.signal.aborted) {
        task.graph.setNodeStatus(nodeId, "cancelled");
        return "cancelled";
      }
      const message = err instanceof Error ? err.message : String(err);
      task.graph.setNodeError(nodeId, message);
      task.graph.setNodeStatus(nodeId, "failed");
      await this._emitNodeFailed(task, nodeId, message);
      return "failed";
    } finally {
      task.nodeControllers.delete(nodeId);
      task.controller.signal.removeEventListener("abort", forwardAbort);
    }
  }

  private async _modelTurn(
    task: ActiveTask,
    nodeId: TaskNodeId,
    transcript: string,
    memoryText: string,
    signal: AbortSignal,
  ): Promise<{ transcript: string; toolCalls: readonly RequestedToolCall[]; completed: boolean }> {
    const node = task.graph.getNode(nodeId);
    const goal = node?.goal ?? task.goal;
    const history: ChatMessageInput[] = [
      {
        id: createMessageId(),
        role: "user",
        content: [
          {
            type: "text",
            text: `Goal: ${goal}${transcript ? `\n\nProgress so far:\n${transcript}` : ""}`,
          },
        ],
      },
    ];

    const outcome = await this._modelInvoker.chat(
      {
        conversationId: task.conversationId,
        modelId: (task.modelId ?? "agent:default") as ModelId,
        messages: history,
        systemPrompt: task.systemPrompt
          ? `${task.systemPrompt}${memoryText ? `\n\n${memoryText}` : ""}`
          : memoryText || undefined,
      },
      history,
      signal,
    );

    return {
      transcript: outcome.transcript,
      toolCalls: outcome.toolCalls,
      completed: outcome.completed,
    };
  }

  private async _executeToolCall(
    task: ActiveTask,
    nodeId: TaskNodeId,
    toolCall: RequestedToolCall,
    signal: AbortSignal,
  ): Promise<string | "blocked" | "cancelled" | "failed" | "failed-transient"> {
    const attemptsAllowed = MAX_AUTO_RETRIES + 1;

    // External permission gateway: blocked without executing the tool.
    // The real toolCallId threads through so allow_once grants stay scoped.
    if (this._permissionGateway) {
      try {
        const blocked = await this._permissionGateway.isBlocked(
          toolCall.toolName,
          task.projectId,
          toolCall.toolCallId,
        );
        if (blocked) return "blocked";
      } catch {
        // Gateway failure is fail-closed: block rather than execute blindly.
        return "blocked";
      }
    }

    await this._emitToolStarted(task, toolCall);

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      if (signal.aborted || task.controller.signal.aborted) {
        await this._emitToolEnded(task, toolCall, "cancelled", "Tool call cancelled");
        return "cancelled";
      }
      try {
        const result = await this._toolInvoker.invoke(
          toolCall.toolName,
          toolCall.input,
          {
            toolCallId: toolCall.toolCallId,
            projectId: task.projectId,
            conversationId: task.conversationId,
          },
          signal,
        );
        if (result.isError) {
          const message =
            typeof result.result === "string" ? result.result : JSON.stringify(result.result);
          // Permission-shaped tool errors block; never auto-retry.
          if (isPermissionDenial(message)) {
            await this._emitToolEnded(task, toolCall, "blocked", message);
            return "blocked";
          }
          if (attempt < attemptsAllowed && isTransientTechnicalFailure(message)) {
            continue; // One automatic transient retry.
          }
          await this._emitToolEnded(task, toolCall, "failed", message);
          return attempt < attemptsAllowed && isTransientTechnicalFailure(message)
            ? "failed-transient"
            : "failed";
        }
        const text =
          typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        await this._emitToolEnded(task, toolCall, "completed", text);
        return text;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (signal.aborted || task.controller.signal.aborted) {
          await this._emitToolEnded(task, toolCall, "cancelled", message);
          return "cancelled";
        }
        if (isPermissionDenial(message)) {
          await this._emitToolEnded(task, toolCall, "blocked", message);
          return "blocked";
        }
        if (attempt < attemptsAllowed && isTransientTechnicalFailure(message)) {
          continue;
        }
        await this._emitToolEnded(task, toolCall, "failed", message);
        return "failed";
      }
    }
    await this._emitToolEnded(task, toolCall, "failed", "Tool call failed after retry");
    return "failed";
  }

  // -------------------------------------------------------------------------
  // Summaries & failures
  // -------------------------------------------------------------------------

  private _summarize(task: ActiveTask): string {
    const parts: string[] = [];
    for (const [, node] of task.graph.snapshot().nodes) {
      if (typeof node.result === "string" && node.result) {
        parts.push(`${node.goal}: ${node.result}`);
      }
    }
    return parts.length > 0 ? parts.join("\n") : `Task "${task.goal}" completed.`;
  }

  private _collectFailure(task: ActiveTask): string {
    const errors: string[] = [];
    for (const [, node] of task.graph.snapshot().nodes) {
      if (node.status === "failed" && node.error) {
        errors.push(`${node.goal}: ${node.error}`);
      }
    }
    return errors.length > 0 ? errors.join("; ") : "Task failed.";
  }

  // -------------------------------------------------------------------------
  // Canonical event emission (EventSink -> EventBus -> storage)
  // -------------------------------------------------------------------------

  private _baseFields(task: ActiveTask) {
    return {
      eventId: createEventId(),
      conversationId: task.conversationId,
      sequence: task.sequence++,
      schemaVersion: 1,
      timestamp: now(),
    };
  }

  private async _emitTaskCreated(task: ActiveTask): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.created",
      category: "extension",
      taskId: task.context.taskId,
      title: task.goal,
      rootNodeIds: [...task.graph.rootNodeIds],
    } as AIEvent);
  }

  private async _emitTaskStarted(task: ActiveTask): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.started",
      category: "extension",
      taskId: task.context.taskId,
    } as AIEvent);
  }

  private async _emitTaskCompleted(task: ActiveTask): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.completed",
      category: "extension",
      taskId: task.context.taskId,
    } as AIEvent);
  }

  private async _emitTaskFailed(task: ActiveTask, error: string): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.failed",
      category: "extension",
      taskId: task.context.taskId,
      error,
    } as AIEvent);
  }

  private async _emitTaskCancelled(task: ActiveTask, reason: string): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.cancelled",
      category: "extension",
      taskId: task.context.taskId,
      reason,
    } as AIEvent);
  }

  private async _emitTaskBlocked(
    task: ActiveTask,
    nodeId: TaskNodeId,
    reason: string,
  ): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.blocked",
      category: "extension",
      taskId: task.context.taskId,
      nodeId,
      reason,
    } as AIEvent);
  }

  private async _emitTaskReplan(
    task: ActiveTask,
    reason: string | undefined,
    addedIds: readonly TaskNodeId[],
    removedIds: readonly TaskNodeId[],
  ): Promise<void> {
    // Include full TaskNode-shaped addedNodes so event replay (projectTaskGraph)
    // restores replan-added nodes instead of only removing nodes.
    const addedNodes = addedIds
      .map((id) => task.graph.getNode(id))
      .filter((node): node is NonNullable<typeof node> => node !== undefined)
      .map((node) => ({
        id: node.id,
        taskId: task.context.taskId,
        parentId: node.parentId,
        goal: node.goal,
        title: node.goal,
        status: "pending" as const,
        dependsOn: [...node.dependsOn],
        dependencies: [...node.dependsOn],
        createdAt: now(),
        updatedAt: now(),
      }));
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.replan",
      category: "extension",
      taskId: task.context.taskId,
      ...(reason ? { reason } : {}),
      ...(addedNodes.length > 0 ? { addedNodes } : {}),
      ...(removedIds.length > 0 ? { removedNodeIds: [...removedIds] } : {}),
    } as AIEvent);
  }

  private async _emitSubtaskCreated(
    task: ActiveTask,
    nodeId: TaskNodeId,
    goal: string,
    dependsOn: readonly TaskNodeId[],
  ): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.subtask.created",
      category: "extension",
      taskId: task.context.taskId,
      nodeId,
      goal,
      dependsOn: [...dependsOn],
      status: "pending",
    } as AIEvent);
  }

  private async _emitNodeStarted(task: ActiveTask, nodeId: TaskNodeId): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.node.started",
      category: "extension",
      taskId: task.context.taskId,
      taskNodeId: nodeId,
    } as AIEvent);
  }

  private async _emitNodeCompleted(
    task: ActiveTask,
    nodeId: TaskNodeId,
    result: unknown,
  ): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.node.completed",
      category: "extension",
      taskId: task.context.taskId,
      taskNodeId: nodeId,
      result,
    } as AIEvent);
  }

  private async _emitNodeFailed(
    task: ActiveTask,
    nodeId: TaskNodeId,
    error: string,
  ): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "task.node.failed",
      category: "extension",
      taskId: task.context.taskId,
      taskNodeId: nodeId,
      error,
    } as AIEvent);
  }

  private async _emitToolStarted(task: ActiveTask, toolCall: RequestedToolCall): Promise<void> {
    await this._eventSink.publish({
      ...this._baseFields(task),
      type: "tool.call.started",
      category: "capability",
      toolCallId: toolCall.toolCallId,
    } as AIEvent);
  }

  private async _emitToolEnded(
    task: ActiveTask,
    toolCall: RequestedToolCall,
    outcome: "completed" | "failed" | "cancelled" | "blocked",
    detail: string,
  ): Promise<void> {
    const base = this._baseFields(task);
    if (outcome === "completed") {
      await this._eventSink.publish({
        ...base,
        type: "tool.call.completed",
        category: "capability",
        toolCallId: toolCall.toolCallId,
        result: detail,
      } as AIEvent);
    } else if (outcome === "cancelled") {
      await this._eventSink.publish({
        ...base,
        type: "tool.call.failed",
        category: "capability",
        toolCallId: toolCall.toolCallId,
        error: `Cancelled: ${detail}`,
      } as AIEvent);
    } else if (outcome === "blocked") {
      await this._eventSink.publish({
        ...base,
        type: "tool.call.failed",
        category: "capability",
        toolCallId: toolCall.toolCallId,
        error: `Blocked: ${detail}`,
      } as AIEvent);
    } else {
      await this._eventSink.publish({
        ...base,
        type: "tool.call.failed",
        category: "capability",
        toolCallId: toolCall.toolCallId,
        error: detail,
      } as AIEvent);
    }
  }
}

// Re-export for test convenience
export { createTaskNodeId, createToolCallId, createMessageId };
