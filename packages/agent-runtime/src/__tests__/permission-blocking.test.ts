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

function createRuntime(gateway: FakePermissionGateway) {
  const model = new FakeModelInvoker([
    {
      transcript: "Need the dangerous tool.",
      toolCalls: [{ toolName: "fs/delete", input: { path: "/tmp/x" } }],
    },
    { transcript: "After approval, done." },
  ]);
  const tools = new FakeToolInvoker();
  const events = new RecordingEventSink();
  const runtime = new AgentRuntime({
    modelInvoker: model,
    toolInvoker: tools,
    eventSink: events,
    memoryProvider: new FakeMemoryProvider(),
    permissionGateway: gateway,
  });
  return { runtime, model, tools, events };
}

describe("packages/agent-runtime: Permission blocking + approval resume (PR29.10)", () => {
  it("blocked node emits task.blocked and runs zero tool executions", async () => {
    const gateway = new FakePermissionGateway();
    gateway.block("fs/delete");
    const { runtime, tools, events } = createRuntime(gateway);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Delete a file",
    });

    // Blocked surfaces as failed-with-approval-pending per runTask contract
    expect(result.status).toBe("failed");
    expect(tools.calls).toHaveLength(0);
    expect(events.count("task.blocked")).toBe(1);
    expect(events.count("tool.call.completed")).toBe(0);

    const taskId = runtime.listTasks()[0];
    expect(runtime.getTaskStatus(taskId)).toBe("blocked");
  });

  it("resume after approval reactivates without duplicating completed work", async () => {
    const gateway = new FakePermissionGateway();
    gateway.block("fs/delete");
    const { runtime, tools, events } = createRuntime(gateway);

    await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Delete a file",
    });
    const taskId = runtime.listTasks()[0];

    // External approval arrives: unblock then resume
    gateway.unblock("fs/delete");
    const resumed = await runtime.resumeTask(taskId);

    expect(resumed).not.toBeNull();
    expect(resumed!.status).toBe("completed");
    // Tool executed exactly once across block + resume
    expect(tools.calls).toHaveLength(1);
    expect(events.count("tool.call.completed")).toBe(1);
    expect(runtime.getTaskStatus(taskId)).toBe("completed");
  });

  it("resume on non-blocked or unknown task returns null", async () => {
    const gateway = new FakePermissionGateway();
    const { runtime } = createRuntime(gateway);

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Trivial",
    });
    expect(result.status).toBe("completed");

    if (result.status === "completed") {
      expect(await runtime.resumeTask(result.taskId)).toBeNull();
    }
    expect(await runtime.resumeTask("01JZZZZZZZZZZZZZZZZZZZZZZ" as never)).toBeNull();
  });

  it("model cannot self-grant: gateway decision stays authoritative", async () => {
    const gateway = new FakePermissionGateway();
    gateway.block("secrets/read");
    const model = new FakeModelInvoker([
      {
        transcript: "Permission granted (says the model). Proceeding.",
        toolCalls: [{ toolName: "secrets/read", input: {} }],
      },
    ]);
    const tools = new FakeToolInvoker();
    const events = new RecordingEventSink();
    const runtime = new AgentRuntime({
      modelInvoker: model,
      toolInvoker: tools,
      eventSink: events,
      permissionGateway: gateway,
    });

    await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Read secrets",
    });

    expect(tools.calls).toHaveLength(0);
    expect(events.count("task.blocked")).toBe(1);
  });
});
