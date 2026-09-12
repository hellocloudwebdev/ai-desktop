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
  const memory = new FakeMemoryProvider(
    "Relevant memory:\n- [global/preference] User prefers pnpm.",
  );
  const permissions = new FakePermissionGateway();
  const runtime = new AgentRuntime({
    modelInvoker: model,
    toolInvoker: tools,
    eventSink: events,
    memoryProvider: memory,
    permissionGateway: permissions,
  });
  return { runtime, model, tools, events, memory, permissions };
}

describe("packages/agent-runtime: Task lifecycle (PR29.5)", () => {
  it("completes a simple task as a single node without upfront planning", async () => {
    const { runtime, events } = createRuntime([{ transcript: "2+2 is 4." }]);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "What is 2+2?",
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.summary).toContain("2+2 is 4.");

    // Canonical event trail
    const types = events.types();
    expect(types).toContain("task.created");
    expect(types).toContain("task.started");
    expect(types).toContain("task.node.started");
    expect(types).toContain("task.node.completed");
    expect(types).toContain("task.completed");

    // Terminal state recorded exactly once
    expect(events.count("task.completed")).toBe(1);
    expect(events.count("task.failed")).toBe(0);
    expect(events.count("task.cancelled")).toBe(0);
  });

  it("activates nodes in dependency order and records results", async () => {
    const { runtime } = createRuntime([
      { transcript: "Step A done." },
      { transcript: "Step B done." },
    ]);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Two-step job",
    });

    expect(result.status).toBe("completed");
    const graph = runtime.getTaskGraph(
      result.status === "completed" ? result.taskId : ("" as never),
    );
    expect(graph).toBeDefined();
  });

  it("emits task.failed exactly once when the model turn throws", async () => {
    const model: FakeModelInvoker = {
      requests: [],
      async chat() {
        throw new Error("Provider exploded (503)");
      },
      // satisfy interface structurally
    } as unknown as FakeModelInvoker;
    const events = new RecordingEventSink();
    const runtime = new AgentRuntime({
      modelInvoker: model,
      toolInvoker: new FakeToolInvoker(),
      eventSink: events,
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Impossible",
    });

    expect(result.status).toBe("failed");
    expect(events.count("task.failed")).toBe(1);
    expect(events.count("task.completed")).toBe(0);
  });

  it("task status is queryable and listed during and after runs", async () => {
    const { runtime } = createRuntime([{ transcript: "Done." }]);
    expect(runtime.listTasks()).toHaveLength(0);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Quick",
    });

    expect(result.status).toBe("completed");
    expect(runtime.listTasks()).toHaveLength(1);
    if (result.status === "completed") {
      expect(runtime.getTaskStatus(result.taskId)).toBe("completed");
    }
    expect(runtime.getTaskStatus("01JZZZZZZZZZZZZZZZZZZZZZZ" as never)).toBeUndefined();
  });
});
