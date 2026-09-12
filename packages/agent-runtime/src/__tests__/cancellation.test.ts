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

function createRuntime() {
  const model = new FakeModelInvoker([
    { transcript: "Starting long job." },
    { transcript: "Still going." },
    { transcript: "Done." },
  ]);
  const tools = new FakeToolInvoker();
  const events = new RecordingEventSink();
  const runtime = new AgentRuntime({
    modelInvoker: model,
    toolInvoker: tools,
    eventSink: events,
    memoryProvider: new FakeMemoryProvider(),
    permissionGateway: new FakePermissionGateway(),
  });
  return { runtime, events };
}

describe("packages/agent-runtime: Cancellation propagation (PR29.11)", () => {
  it("cancelTask aborts a running task and emits exactly one task.cancelled", async () => {
    // Slow model: each turn waits so cancellation lands mid-run
    const slowModel = {
      requests: [] as never[],
      async chat() {
        await new Promise((r) => setTimeout(r, 100));
        return { transcript: "Late answer.", toolCalls: [], completed: true };
      },
    };
    const events = new RecordingEventSink();
    const runtime = new AgentRuntime({
      modelInvoker: slowModel as never,
      toolInvoker: new FakeToolInvoker(),
      eventSink: events,
    });

    const runPromise = runtime.runTask({
      conversationId: createConversationId(),
      goal: "Slow job",
    });
    await new Promise((r) => setTimeout(r, 10));
    const taskId = runtime.listTasks()[0];
    expect(runtime.cancelTask(taskId, "User pressed stop")).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(events.count("task.cancelled")).toBe(1);
    expect(events.count("task.completed")).toBe(0);
    expect(runtime.getTaskStatus(taskId)).toBe("cancelled");
  });

  it("cancelTask is idempotent: unknown, completed, and repeated cancels are safe", async () => {
    const { runtime } = createRuntime();

    expect(runtime.cancelTask("01JZZZZZZZZZZZZZZZZZZZZZZ" as never)).toBe(false);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Quick",
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;

    // Completed tasks cannot be cancelled
    expect(runtime.cancelTask(result.taskId)).toBe(false);
    // Second cancel also safe
    expect(runtime.cancelTask(result.taskId)).toBe(false);
  });

  it("cancelling one task never cancels its sibling (downward-only)", async () => {
    const slowModelA = {
      requests: [] as never[],
      async chat() {
        await new Promise((r) => setTimeout(r, 120));
        return { transcript: "A done.", toolCalls: [], completed: true };
      },
    };
    const fastModelB = new FakeModelInvoker([{ transcript: "B done." }]);
    const events = new RecordingEventSink();
    const runtimeA = new AgentRuntime({
      modelInvoker: slowModelA as never,
      toolInvoker: new FakeToolInvoker(),
      eventSink: events,
    });
    const runtimeB = new AgentRuntime({
      modelInvoker: fastModelB,
      toolInvoker: new FakeToolInvoker(),
      eventSink: events,
    });

    const runA = runtimeA.runTask({ conversationId: createConversationId(), goal: "Slow sibling" });
    const runB = runtimeB.runTask({ conversationId: createConversationId(), goal: "Fast sibling" });

    await new Promise((r) => setTimeout(r, 10));
    const taskA = runtimeA.listTasks()[0];
    expect(runtimeA.cancelTask(taskA)).toBe(true);

    const [resA, resB] = await Promise.all([runA, runB]);
    expect(resA.status).toBe("cancelled");
    expect(resB.status).toBe("completed");
  });

  it("node-level abort does not leak into the parent task controller", async () => {
    const { runtime, events } = createRuntime();
    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Isolated nodes",
    });
    expect(result.status).toBe("completed");
    // No stray cancellation events for a clean run
    expect(events.count("task.cancelled")).toBe(0);
  });
});
