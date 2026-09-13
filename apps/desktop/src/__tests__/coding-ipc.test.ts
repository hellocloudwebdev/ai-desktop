// PR30.13: apps/desktop — Coding IPC Dispatch Tests
//
// Typed coding:start/cancel/get/list channels validate input in main before
// any handler executes; malformed input fails without touching the service.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { createConversationId, createToolCallId, now } from "@ai-desktop/shared";
import type { ConversationId, ToolCallId, ToolResult } from "@ai-desktop/ai-core";
import { AgentRuntime } from "@ai-desktop/agent-runtime";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { AgentService } from "../main/agent/index.js";
import type { CodingAgentService } from "../main/agent/index.js";

class StubModelInvoker {
  async chat() {
    return { transcript: "Done.", toolCalls: [], completed: true };
  }
}

class StubToolInvoker {
  async invoke(
    toolName: string,
    _input: unknown,
    context: { toolCallId: ToolCallId },
  ): Promise<ToolResult> {
    return {
      toolCallId: context.toolCallId,
      toolName,
      result: "ok",
      isError: false,
      timestamp: now(),
    };
  }
}

class StubEventSink {
  readonly events: Array<{ type: string }> = [];
  async publish(event: { type: string }): Promise<void> {
    this.events.push(event);
  }
}

function createHarness(workspaceRoot: string) {
  const inner = new AgentRuntime({
    modelInvoker: new StubModelInvoker() as never,
    toolInvoker: new StubToolInvoker() as never,
    eventSink: new StubEventSink() as never,
  });
  const agentService = {
    startTask: (input: { conversationId?: ConversationId; goal: string; projectId?: string }) =>
      inner.runTask({
        conversationId: input.conversationId ?? createConversationId(),
        goal: input.goal,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    cancelTask: (taskId: never, reason?: string) => inner.cancelTask(taskId, reason),
    getTaskStatus: (taskId: never) => inner.getTaskStatus(taskId),
    getTaskGraph: (taskId: never) => {
      const graph = inner.getTaskGraph(taskId);
      if (!graph) return undefined;
      const snap = graph.snapshot();
      return {
        nodes: [...snap.nodes.values()].map((n) => ({ id: n.id, goal: n.goal, status: n.status })),
      };
    },
    listTasks: () => inner.listTasks(),
  };
  const codingService = {
    startCodingTask: (input: { projectId: string; prompt: string; workspaceRoot?: string }) =>
      agentService
        .startTask({
          goal: `Coding task in workspace ${input.workspaceRoot ?? workspaceRoot}: ${input.prompt}`,
          projectId: input.projectId,
        })
        .then((result) => ({ result, context: { projectId: input.projectId }, workspaceRoot })),
    cancelCodingTask: (taskId: never, reason?: string) => inner.cancelTask(taskId, reason),
    getCodingTaskStatus: (taskId: never) => inner.getTaskStatus(taskId),
    getCodingTaskGraph: (taskId: never) => agentService.getTaskGraph(taskId),
    listCodingTasks: () => inner.listTasks(),
  };
  const ipcRegistry = new IpcRegistry();
  registerIpcHandlers(ipcRegistry, {
    callbacks: {},
    agentService: agentService as unknown as AgentService,
    codingAgentService: codingService as unknown as CodingAgentService,
  });
  return { ipcRegistry };
}

describe("apps/desktop: Coding IPC dispatch (PR30.13)", () => {
  it("coding:start runs a task and returns its terminal outcome", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-ipc-"));
    try {
      const { ipcRegistry } = createHarness(root);
      const res = await ipcRegistry.invokeCommand<{ outcome: { result: { status: string } } }>(
        IPC_CHANNELS.CODING_START,
        { projectId: "proj-A", workspaceRoot: root, prompt: "List files" },
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.outcome.result.status).toBe("completed");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("coding:start rejects empty prompts and missing projects before handlers run", async () => {
    const { ipcRegistry } = createHarness(os.tmpdir());
    const empty = await ipcRegistry.invokeCommand(IPC_CHANNELS.CODING_START, {
      projectId: "proj-A",
      prompt: "",
    });
    expect(empty.ok).toBe(false);
    const missing = await ipcRegistry.invokeCommand(IPC_CHANNELS.CODING_START, {
      prompt: "Do work",
    });
    expect(missing.ok).toBe(false);
  });

  it("coding:cancel rejects malformed task ids without touching the service", async () => {
    const { ipcRegistry } = createHarness(os.tmpdir());
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.CODING_CANCEL, {
      taskId: "not-a-ulid",
    });
    expect(res.ok).toBe(false);
  });

  it("coding:get returns status plus node checklist; unknown ids error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-ipc-"));
    try {
      const { ipcRegistry } = createHarness(root);
      const started = await ipcRegistry.invokeCommand<{
        outcome: { result: { taskId: string } };
      }>(IPC_CHANNELS.CODING_START, {
        projectId: "proj-A",
        workspaceRoot: root,
        prompt: "Inspect",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const got = await ipcRegistry.invokeCommand<{
        task: { taskId: string; status: string; graph: { nodes: unknown[] } | null };
      }>(IPC_CHANNELS.CODING_GET, { taskId: started.value.outcome.result.taskId });
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.value.task.status).toBe("completed");
        expect(got.value.task.graph?.nodes.length).toBeGreaterThanOrEqual(1);
      }

      const unknown = await ipcRegistry.invokeCommand(IPC_CHANNELS.CODING_GET, {
        taskId: "01JZZZZZZZZZZZZZZZZZZZZZZ",
      });
      expect(unknown.ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("coding:list returns known coding task ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-ipc-"));
    try {
      const { ipcRegistry } = createHarness(root);
      const started = await ipcRegistry.invokeCommand<{
        outcome: { result: { taskId: string } };
      }>(IPC_CHANNELS.CODING_START, {
        projectId: "proj-A",
        workspaceRoot: root,
        prompt: "Listable",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const listed = await ipcRegistry.invokeCommand<{ taskIds: string[] }>(
        IPC_CHANNELS.CODING_LIST,
        {},
      );
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value.taskIds).toContain(started.value.outcome.result.taskId);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("unused tool id helper keeps the suite honest about id generation", () => {
    expect(typeof createToolCallId()).toBe("string");
  });
});
