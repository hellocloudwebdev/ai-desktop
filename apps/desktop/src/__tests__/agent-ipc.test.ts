// PR29.17: apps/desktop — Agent IPC Dispatch Tests
//
// Typed agent:start/cancel/get/list channels validate input in main before
// any handler executes; malformed input fails without touching the service.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { createConversationId } from "@ai-desktop/shared";
import { now } from "@ai-desktop/shared";
import type { ConversationId, ToolCallId, ToolResult } from "@ai-desktop/ai-core";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import { AgentService } from "../main/agent/index.js";
import { AgentRuntime } from "@ai-desktop/agent-runtime";

class StubModelInvoker {
  async chat() {
    return { transcript: "Done.", toolCalls: [], completed: true };
  }
}

class StubToolInvoker {
  readonly calls: string[] = [];
  async invoke(
    toolName: string,
    _input: unknown,
    context: { toolCallId: ToolCallId },
  ): Promise<ToolResult> {
    this.calls.push(toolName);
    return {
      toolCallId: context.toolCallId,
      toolName,
      result: `ok:${toolName}`,
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
  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

function createHarness() {
  const events = new StubEventSink();
  const inner = new AgentRuntime({
    modelInvoker: new StubModelInvoker() as never,
    toolInvoker: new StubToolInvoker() as never,
    eventSink: events as never,
  });
  // Drive the real runtime through the AgentService-shaped IPC handlers by
  // injecting callback overrides (no Electron needed).
  const service = {
    startTask: (input: { conversationId: ConversationId; goal: string }) =>
      inner.runTask({ conversationId: input.conversationId, goal: input.goal }),
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
  const ipcRegistry = new IpcRegistry();
  registerIpcHandlers(ipcRegistry, {
    callbacks: {},
    agentService: service as unknown as AgentService,
  });
  return { ipcRegistry, events };
}

describe("apps/desktop: Agent IPC dispatch (PR29.17)", () => {
  it("agent:start runs a task and returns its terminal result", async () => {
    const { ipcRegistry } = createHarness();
    const res = await ipcRegistry.invokeCommand<{ result: { status: string } }>(
      IPC_CHANNELS.AGENT_START,
      { conversationId: createConversationId(), goal: "Typed start" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.result.status).toBe("completed");
    }
  });

  it("agent:start rejects empty goals before any handler executes", async () => {
    const { ipcRegistry, events } = createHarness();
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.AGENT_START, {
      conversationId: createConversationId(),
      goal: "",
    });
    expect(res.ok).toBe(false);
    expect(events.count("task.created")).toBe(0);
  });

  it("agent:cancel reports cancellation for the running task id", async () => {
    const { ipcRegistry } = createHarness();
    const started = await ipcRegistry.invokeCommand<{ result: { taskId: string } }>(
      IPC_CHANNELS.AGENT_START,
      { conversationId: createConversationId(), goal: "Cancellable" },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Completed tasks cannot be cancelled (downward-only, terminal is final)
    const cancelled = await ipcRegistry.invokeCommand<{ cancelled: boolean }>(
      IPC_CHANNELS.AGENT_CANCEL,
      { taskId: started.value.result.taskId },
    );
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.cancelled).toBe(false);
    }
  });

  it("agent:cancel rejects malformed task ids without touching the service", async () => {
    const { ipcRegistry, events } = createHarness();
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.AGENT_CANCEL, {
      taskId: "not-a-ulid",
    });
    expect(res.ok).toBe(false);
    expect(events.events).toHaveLength(0);
  });

  it("agent:get returns status plus node checklist; unknown ids error", async () => {
    const { ipcRegistry } = createHarness();
    const started = await ipcRegistry.invokeCommand<{ result: { taskId: string } }>(
      IPC_CHANNELS.AGENT_START,
      { conversationId: createConversationId(), goal: "Inspectable" },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const got = await ipcRegistry.invokeCommand<{
      task: { taskId: string; status: string; graph: { nodes: unknown[] } | null };
    }>(IPC_CHANNELS.AGENT_GET, { taskId: started.value.result.taskId });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.task.status).toBe("completed");
      expect(got.value.task.graph?.nodes.length).toBeGreaterThanOrEqual(1);
    }

    const unknown = await ipcRegistry.invokeCommand(IPC_CHANNELS.AGENT_GET, {
      taskId: "01JZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(unknown.ok).toBe(false);
  });

  it("agent:list returns known task ids", async () => {
    const { ipcRegistry } = createHarness();
    const started = await ipcRegistry.invokeCommand<{ result: { taskId: string } }>(
      IPC_CHANNELS.AGENT_START,
      { conversationId: createConversationId(), goal: "Listable" },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const listed = await ipcRegistry.invokeCommand<{ taskIds: string[] }>(
      IPC_CHANNELS.AGENT_LIST,
      {},
    );
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.taskIds).toContain(started.value.result.taskId);
    }
  });
});
