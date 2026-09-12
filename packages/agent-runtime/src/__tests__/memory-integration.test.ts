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

describe("packages/agent-runtime: Memory integration (PR29.15)", () => {
  it("retrieves memory scoped to the task project before model execution", async () => {
    const memory = new FakeMemoryProvider(
      "Relevant memory:\n- [project:proj-A/preference] Uses pnpm.",
    );
    const model = new FakeModelInvoker([{ transcript: "Done." }]);
    const runtime = new AgentRuntime({
      modelInvoker: model,
      toolInvoker: new FakeToolInvoker(),
      eventSink: new RecordingEventSink(),
      memoryProvider: memory,
      permissionGateway: new FakePermissionGateway(),
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Install dependencies",
      projectId: "proj-A",
    });

    expect(result.status).toBe("completed");
    expect(memory.queries).toHaveLength(1);
    expect(memory.queries[0].projectId).toBe("proj-A");
    expect(memory.queries[0].goal).toContain("Install dependencies");
  });

  it("propagates projectId so unrelated project memory is never retrieved", async () => {
    const memory = new FakeMemoryProvider("");
    const runtime = new AgentRuntime({
      modelInvoker: new FakeModelInvoker([{ transcript: "Done." }]),
      toolInvoker: new FakeToolInvoker(),
      eventSink: new RecordingEventSink(),
      memoryProvider: memory,
    });

    await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Confidential query",
      projectId: "project-B",
    });

    expect(memory.queries).toHaveLength(1);
    expect(memory.queries[0].projectId).toBe("project-B");
  });

  it("runs without a memory provider (memory is optional)", async () => {
    const model = new FakeModelInvoker([{ transcript: "Done without memory." }]);
    const runtime = new AgentRuntime({
      modelInvoker: model,
      toolInvoker: new FakeToolInvoker(),
      eventSink: new RecordingEventSink(),
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "No memory configured",
    });

    expect(result.status).toBe("completed");
    // No memory text injected, but the run still completes
    expect(model.requests[0].systemPrompt).toBeUndefined();
  });

  it("memory failure degrades gracefully instead of failing the task", async () => {
    const failingMemory = new FakeMemoryProvider("unreachable");
    failingMemory.retrieveForTask = async () => {
      throw new Error("Memory backend unavailable");
    };
    const runtime = new AgentRuntime({
      modelInvoker: new FakeModelInvoker([{ transcript: "Done anyway." }]),
      toolInvoker: new FakeToolInvoker(),
      eventSink: new RecordingEventSink(),
      memoryProvider: failingMemory,
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Resilient job",
    });

    expect(result.status).toBe("completed");
  });
});
