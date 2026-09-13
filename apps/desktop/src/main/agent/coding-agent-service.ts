// PR30.9/30.10: apps/desktop — CodingAgentService (Desktop Composition)
//
// Invariants:
//   1. The coding agent is a specialized consumer of the PR29 AgentRuntime, not a
//      second runtime: it builds context, registers coding tools, starts the task
//      through AgentService, and never implements its own ReAct loop.
//   2. Workspace binding is project-scoped: resolveWorkspace maps projectId to an
//      explicit root; tasks without a registered workspace fail closed.
//   3. The model-facing operating contract demands verified claims: read/search
//      before modifying, smallest change, run validation, report only what tool
//      output proves.

import {
  validateCodingTaskRequest,
  type ConversationId,
  type TaskId,
  type ValidatedCodingContext,
} from "@ai-desktop/ai-core";
import type { AgentTaskResult } from "@ai-desktop/agent-runtime";
import { createConversationId } from "@ai-desktop/shared";
import type { AgentService } from "./agent-service.js";
import { CodingToolExecutor } from "./coding-tools.js";

export const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent operating inside an explicit project workspace.
Operating contract:
1. Understand the task before acting.
2. Inspect the workspace first: list directories, search for relevant files.
3. Prefer reading/searching before modifying anything.
4. Make the smallest appropriate change that fixes the problem.
5. Run the relevant validation or tests after every change.
6. Inspect failures from actual tool output; correct issues where justified.
7. Re-run validation after corrections.
8. Report exactly what changed and what was verified.
Hard rules:
- Never claim tests passed unless tool output proves it.
- Never claim files changed unless tool results show it.
- Never invent command output or repository structure.
- Never access paths outside the workspace; all file tools are workspace-scoped.
- Stop cleanly when the task is cancelled.`;

export interface CodingAgentServiceDeps {
  readonly agentService: AgentService;
  readonly codingToolExecutor: CodingToolExecutor;
}

export interface StartCodingTaskInput {
  readonly projectId: string;
  readonly workspaceRoot?: string;
  readonly cwd?: string;
  readonly prompt: string;
  readonly conversationId?: ConversationId;
  readonly modelId?: string;
  readonly maxNodeIterations?: number;
}

export interface CodingTaskOutcome {
  readonly result: AgentTaskResult;
  readonly context: ValidatedCodingContext;
  readonly workspaceRoot: string;
}

/**
 * Desktop coding-agent composition over the PR29 runtime.
 */
export class CodingAgentService {
  private readonly _agentService: AgentService;
  private readonly _codingToolExecutor: CodingToolExecutor;
  private readonly _workspaces = new Map<string, string>();

  constructor(deps: CodingAgentServiceDeps) {
    this._agentService = deps.agentService;
    this._codingToolExecutor = deps.codingToolExecutor;
  }

  get executor(): CodingToolExecutor {
    return this._codingToolExecutor;
  }

  registerWorkspace(projectId: string, workspaceRoot: string): void {
    this._workspaces.set(projectId, workspaceRoot);
  }

  resolveWorkspace(projectId?: string): string | undefined {
    if (!projectId) return undefined;
    return this._workspaces.get(projectId);
  }

  listWorkspaces(): Array<{ projectId: string; workspaceRoot: string }> {
    return [...this._workspaces.entries()].map(([projectId, workspaceRoot]) => ({
      projectId,
      workspaceRoot,
    }));
  }

  /**
   * Starts a coding task: validates the request, binds the workspace, and
   * drives the existing PR29 runtime to a single terminal result.
   */
  async startCodingTask(input: StartCodingTaskInput): Promise<CodingTaskOutcome> {
    if (input.workspaceRoot) {
      this.registerWorkspace(input.projectId, input.workspaceRoot);
    }
    // Fail closed before schema validation so unregistered projects get the
    // explicit workspace error instead of a generic schema message.
    const workspaceRoot = this._workspaces.get(input.projectId);
    if (!workspaceRoot) {
      throw new Error(`No workspace registered for project "${input.projectId}"`);
    }
    const context = validateCodingTaskRequest({
      projectId: input.projectId,
      workspaceRoot,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      prompt: input.prompt,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.maxNodeIterations ? { maxNodeIterations: input.maxNodeIterations } : {}),
    });
    const goal = `Coding task in workspace ${workspaceRoot} (project ${input.projectId}): ${context.prompt}`;
    const result = await this._agentService.startTask({
      conversationId: context.conversationId ?? createConversationId(),
      goal,
      projectId: input.projectId,
      ...(context.modelId ? { modelId: context.modelId } : {}),
      systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
      ...(context.maxNodeIterations ? { maxNodeIterations: context.maxNodeIterations } : {}),
    });
    return { result, context, workspaceRoot };
  }

  cancelCodingTask(taskId: TaskId, reason?: string): boolean {
    return this._agentService.cancelTask(taskId, reason);
  }

  async resumeCodingTask(taskId: TaskId): Promise<AgentTaskResult | null> {
    return this._agentService.resumeTask(taskId);
  }

  getCodingTaskStatus(taskId: TaskId): string | undefined {
    return this._agentService.getTaskStatus(taskId);
  }

  getCodingTaskGraph(
    taskId: TaskId,
  ): { nodes: Array<{ id: string; goal: string; status: string }> } | undefined {
    const graph = this._agentService.getTaskGraph(taskId);
    if (!graph) return undefined;
    return {
      nodes: graph.nodes.map((n) => ({ id: String(n.id), goal: n.goal, status: n.status })),
    };
  }

  listCodingTasks(): TaskId[] {
    return this._agentService.listTasks();
  }
}
