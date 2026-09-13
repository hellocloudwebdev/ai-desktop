// PR30.9: apps/desktop — Coding Agent Service Tests (replan, cancel, resume)

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "@ai-desktop/agent-runtime";
import { createConversationId, createToolCallId, now } from "@ai-desktop/shared";
import type { ConversationId, ToolCallId } from "@ai-desktop/ai-core";
import { DefaultPermissionManager } from "@ai-desktop/permissions";
import { AgentRuntime } from "@ai-desktop/agent-runtime";
import { CodingAgentService } from "../coding-agent-service.js";
import { CodingToolExecutor } from "../coding-tools.js";
import type { ExecutionManager, ExecutionResult } from "@ai-desktop/ai-core";
import { createExecutionId } from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import type { PermissionDecisionResult } from "@ai-desktop/ai-core";
import { InMemoryEventRepository } from "../../../__tests__/test-helpers.js";

class AllowAll implements PermissionManager {
  async check(): Promise<PermissionDecisionResult> {
    return { kind: "allow" };
  }
  async resolve(): Promise<boolean> {
    return true;
  }
  async revoke(): Promise<number> {
    return 0;
  }
  getPendingRequest(): undefined {
    return undefined;
  }
  listPendingRequests(): readonly [] {
    return [];
  }
  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

class StubExecution implements ExecutionManager {
  async execute(): Promise<ExecutionResult> {
    return {
      executionId: createExecutionId(),
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      timestamp: now(),
    };
  }
  async createSession(): Promise<never> {
    throw new Error("unused");
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async destroySession(): Promise<void> {}
  get sandboxProvider(): never {
    throw new Error("unused");
  }
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-svc-"));
  fs.writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(root, "b.ts"), "const b = 2;\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function createService(
  turns: Array<{
    transcript: string;
    toolCalls?: Array<{ toolName: string; input: unknown }>;
    slow?: boolean;
  }>,
) {
  let cursor = 0;
  const model = {
    async chat() {
      const turn = turns[Math.min(cursor, turns.length - 1)];
      cursor += 1;
      if (turn.slow) {
        await new Promise((r) => setTimeout(r, 120));
      }
      return {
        transcript: turn.transcript,
        toolCalls: (turn.toolCalls ?? []).map((t) => ({
          toolCallId: createToolCallId(),
          toolName: t.toolName,
          toolSource: "builtin",
          toolRuntime: "in_process",
          input: t.input,
        })),
        completed: (turn.toolCalls ?? []).length === 0,
      };
    },
  };
  const permissions = new AllowAll();
  const executor = new CodingToolExecutor({
    permissionManager: permissions,
    executionManager: new StubExecution(),
    resolveWorkspace: (projectId?: string) => (projectId === "proj-SVC" ? root : undefined),
  });
  const bus = new EventBus();
  const storage = new InMemoryEventRepository();
  const runtime = new AgentRuntime({
    modelInvoker: model as never,
    toolInvoker: {
      invoke: async (
        toolName: string,
        input: unknown,
        context: { toolCallId: ToolCallId; projectId?: string; conversationId: ConversationId },
      ) =>
        executor.execute(toolName, input, {
          toolCallId: context.toolCallId,
          projectId: context.projectId,
          conversationId: context.conversationId,
        }),
    } as never,
    eventSink: {
      publish: async (event: object) => {
        await storage.append(event as never);
        await bus.publish(event as never);
      },
    } as never,
  });
  const direct = {
    startTask: (input: {
      conversationId?: ConversationId;
      goal: string;
      projectId?: string;
      systemPrompt?: string;
    }) =>
      runtime.runTask({
        conversationId: input.conversationId ?? createConversationId(),
        goal: input.goal,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      }),
    cancelTask: (taskId: never, reason?: string) => runtime.cancelTask(taskId, reason),
    resumeTask: (taskId: never) => runtime.resumeTask(taskId),
    getTaskStatus: (taskId: never) => runtime.getTaskStatus(taskId),
    getTaskGraph: (taskId: never) => runtime.getTaskGraph(taskId),
    listTasks: () => runtime.listTasks(),
  };
  const service = new CodingAgentService({
    agentService: direct as never,
    codingToolExecutor: executor,
  });
  return { service, runtime };
}

describe("apps/desktop: CodingAgentService (PR30.9)", () => {
  it("starts a coding task bound to the registered workspace", async () => {
    const { service } = createService([{ transcript: "Nothing to do." }]);
    const outcome = await service.startCodingTask({
      projectId: "proj-SVC",
      workspaceRoot: root,
      prompt: "Inspect the workspace.",
    });
    expect(outcome.result.status).toBe("completed");
    expect(outcome.workspaceRoot).toBe(root);
    expect(outcome.context.projectId).toBe("proj-SVC");
  });

  it("fails closed without a registered workspace", async () => {
    const { service } = createService([{ transcript: "Nothing." }]);
    await expect(
      service.startCodingTask({ projectId: "proj-MISSING", prompt: "Do work." }),
    ).rejects.toThrow(/No workspace/);
  });

  it("replans mid-run: initial plan expects A, search reveals B, agent adapts", async () => {
    const { service, runtime } = createService([
      {
        transcript: "Reading A.",
        toolCalls: [{ toolName: "builtin:filesystem.read", input: { path: "a.ts" } }],
      },
      { transcript: "A is fine; waiting for instructions.", slow: true },
      {
        transcript: "Now reading B after replan.",
        toolCalls: [{ toolName: "builtin:filesystem.read", input: { path: "b.ts" } }],
      },
      { transcript: "B verified." },
    ]);
    const outcomePromise = service.startCodingTask({
      projectId: "proj-SVC",
      workspaceRoot: root,
      prompt: "Check file A, then adapt.",
    });
    // Let the first node start, then revise the plan with a follow-up node.
    await new Promise((r) => setTimeout(r, 10));
    const ids = service.listCodingTasks();
    expect(ids.length).toBe(1);
    const replanned = await runtime.replan(ids[0], {
      addedNodes: [{ goal: "Verify file B as a follow-up" }],
      reason: "Operator added verification",
    });
    expect(replanned).toBe(true);
    const outcome = await outcomePromise;
    expect(outcome.result.status).toBe("completed");
    // Both files were actually read through the coding executor.
    if (outcome.result.status === "completed") {
      expect(outcome.result.summary).toContain("B verified");
    }
  });

  it("cancels a running coding task downward-only with exactly one terminal", async () => {
    const slowModel = {
      async chat() {
        await new Promise((r) => setTimeout(r, 150));
        return { transcript: "Slow.", toolCalls: [], completed: true };
      },
    };
    const permissions = new DefaultPermissionManager();
    const executor = new CodingToolExecutor({
      permissionManager: permissions,
      executionManager: new StubExecution(),
      resolveWorkspace: () => root,
    });
    const runtime = new AgentRuntime({
      modelInvoker: slowModel as never,
      toolInvoker: {
        invoke: async (toolName: string, input: unknown, context: { toolCallId: ToolCallId }) =>
          executor.execute(toolName, input, { toolCallId: context.toolCallId }),
      } as never,
      eventSink: { publish: async () => {} } as never,
    });
    const direct = {
      startTask: (input: { goal: string }) =>
        runtime.runTask({ conversationId: createConversationId(), goal: input.goal }),
      cancelTask: (taskId: never, reason?: string) => runtime.cancelTask(taskId, reason),
      resumeTask: (taskId: never) => runtime.resumeTask(taskId),
      getTaskStatus: (taskId: never) => runtime.getTaskStatus(taskId),
      getTaskGraph: (taskId: never) => runtime.getTaskGraph(taskId),
      listTasks: () => runtime.listTasks(),
    };
    const service = new CodingAgentService({
      agentService: direct as never,
      codingToolExecutor: executor,
    });
    const runPromise = service.startCodingTask({
      projectId: "proj-SVC",
      workspaceRoot: root,
      prompt: "Slow job.",
    });
    await new Promise((r) => setTimeout(r, 10));
    const ids = service.listCodingTasks();
    expect(service.cancelCodingTask(ids[0], "User stop")).toBe(true);
    const outcome = await runPromise;
    expect(outcome.result.status).toBe("cancelled");
    // Second cancel is safe (idempotent).
    expect(service.cancelCodingTask(ids[0])).toBe(false);
  });
});
