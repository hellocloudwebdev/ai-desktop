import { describe, expect, it } from "vitest";
import { createConversationId } from "@ai-desktop/shared";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import {
  FakeMemoryProvider,
  FakeModelInvoker,
  FakePermissionGateway,
  FakeToolInvoker,
  RecordingEventSink,
} from "./helpers.js";
import type { ScriptedModelTurn } from "./helpers.js";

function createRuntime(turns?: ScriptedModelTurn[]) {
  const model = new FakeModelInvoker(turns);
  const tools = new FakeToolInvoker();
  const events = new RecordingEventSink();
  const runtime = new AgentRuntime({
    modelInvoker: model,
    toolInvoker: tools,
    eventSink: events,
    memoryProvider: new FakeMemoryProvider(),
    permissionGateway: new FakePermissionGateway(),
  });
  return { runtime, model, tools, events };
}

describe("packages/agent-runtime: Revisable planning (PR29.8)", () => {
  it("replan adds nodes that execute and emits task.replan", async () => {
    const { runtime, events } = createRuntime([
      { transcript: "First part done." },
      { transcript: "Second part done." },
    ]);

    const runPromise = runtime.runTask({
      conversationId: createConversationId(),
      goal: "Two-part job",
    });

    // Wait a tick so the task registers, then revise the plan
    await new Promise((r) => setTimeout(r, 5));
    const taskId = runtime.listTasks()[0];
    expect(taskId).toBeDefined();
    const ok = await runtime.replan(taskId, {
      addedNodes: [{ goal: "Verification step" }],
      reason: "Operator requested verification",
    });
    expect(ok).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(events.count("task.replan")).toBe(1);
    expect(events.count("task.subtask.created")).toBeGreaterThanOrEqual(1);
  });

  it("replan on unknown task returns false without events", async () => {
    const { runtime, events } = createRuntime([{ transcript: "Done." }]);
    const ok = await runtime.replan("01JZZZZZZZZZZZZZZZZZZZZZZ" as never, {
      addedNodes: [{ goal: "Ghost" }],
    });
    expect(ok).toBe(false);
    expect(events.count("task.replan")).toBe(0);
  });

  it("replan can remove a node; removed work never executes", async () => {
    const { runtime, tools } = createRuntime([{ transcript: "Only survivor." }]);

    const runPromise = runtime.runTask({
      conversationId: createConversationId(),
      goal: "Prunable job",
    });
    await new Promise((r) => setTimeout(r, 5));
    const taskId = runtime.listTasks()[0];
    const graph = runtime.getTaskGraph(taskId)!;
    const doomed = graph.addNode({ goal: "Doomed step" });

    await runtime.replan(taskId, { removedNodeIds: [doomed.id], reason: "Scope cut" });

    const result = await runPromise;
    expect(result.status).toBe("completed");
    // Only the model's own turns ran; removed node produced no tool calls
    expect(tools.calls).toHaveLength(0);
    expect(graph.getNode(doomed.id)).toBeUndefined();
  });

  it("failed nodes do not silently vanish: task.failed is emitted with node error", async () => {
    const model = new FakeModelInvoker([
      {
        transcript: "Attempting.",
        toolCalls: [{ toolName: "boom/tool", input: {} }],
      },
    ]);
    const tools = new FakeToolInvoker(() => {
      throw new Error("Semantic failure: bad arguments");
    });
    const events = new RecordingEventSink();
    const runtime = new AgentRuntime({
      modelInvoker: model,
      toolInvoker: tools,
      eventSink: events,
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Fragile job",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("boom/tool");
    }
    expect(events.count("task.node.failed")).toBe(1);
    expect(events.count("task.failed")).toBe(1);
  });
});
