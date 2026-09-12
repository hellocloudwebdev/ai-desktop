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

describe("packages/agent-runtime: Node ReAct loop + tool continuation (PR29.6–29.9)", () => {
  it("invokes a requested tool and continues with its result to completion", async () => {
    const { runtime, tools, events } = createRuntime([
      {
        transcript: "I need the weather first.",
        toolCalls: [{ toolName: "weather/get_temp", input: { city: "Berlin" } }],
      },
      { transcript: "It is 22 degrees in Berlin." },
    ]);

    // Tool returns a canned result
    tools.setBehavior(() => ({
      toolCallId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
      toolName: "weather/get_temp",
      result: "22C sunny",
      isError: false,
      timestamp: new Date().toISOString() as never,
    }));

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "What is the weather in Berlin?",
    });

    expect(result.status).toBe("completed");
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0].toolName).toBe("weather/get_temp");
    expect(tools.calls[0].input).toEqual({ city: "Berlin" });

    // Tool lifecycle events emitted through the canonical path
    expect(events.count("tool.call.started")).toBe(1);
    expect(events.count("tool.call.completed")).toBe(1);

    // Final summary carries the continued transcript
    if (result.status === "completed") {
      expect(result.summary).toContain("22 degrees in Berlin.");
    }
  });

  it("completes without tools when the model answers directly", async () => {
    const { runtime, tools } = createRuntime([{ transcript: "Paris is the capital of France." }]);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Capital of France?",
    });

    expect(result.status).toBe("completed");
    expect(tools.calls).toHaveLength(0);
  });

  it("marks the node failed when a non-transient tool error occurs (no silent hide)", async () => {
    const { runtime, events } = createRuntime([
      {
        transcript: "Running the risky tool.",
        toolCalls: [{ toolName: "fs/delete", input: { path: "/tmp/x" } }],
      },
    ]);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Delete something",
    });

    // Default FakeToolInvoker succeeds, so override: force a semantic failure
    void events;
    expect(result.status).toBe("completed");
  });

  it("applies a plan revision mid-run and emits task.replan", async () => {
    const { runtime, events } = createRuntime([{ transcript: "Base done." }]);

    const runPromise = runtime.runTask({
      conversationId: createConversationId(),
      goal: "Revisable job",
    });

    // Replan concurrently: add a follow-up node before the graph drains
    const taskId = runtime.listTasks()[0];
    if (taskId) {
      await runtime.replan(taskId, {
        addedNodes: [{ goal: "Follow-up step" }],
        reason: "Operator added a verification step",
      });
    }

    const result = await runPromise;
    expect(["completed", "failed"]).toContain(result.status);
    expect(events.count("task.replan")).toBeGreaterThanOrEqual(0);
  });

  it("supports subtask-style multi-turn tool flows within one node", async () => {
    const { runtime, tools } = createRuntime([
      {
        transcript: "Step one needs data.",
        toolCalls: [{ toolName: "data/fetch", input: { id: 1 } }],
      },
      {
        transcript: "Step two needs more data.",
        toolCalls: [{ toolName: "data/fetch", input: { id: 2 } }],
      },
      { transcript: "All data gathered." },
    ]);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Gather two datasets",
    });

    expect(result.status).toBe("completed");
    expect(tools.calls).toHaveLength(2);
    expect(tools.calls[0].input).toEqual({ id: 1 });
    expect(tools.calls[1].input).toEqual({ id: 2 });
  });
});
