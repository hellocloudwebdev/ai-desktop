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

function createRuntimeWithToolBehavior(behavior: (toolName: string) => Error | { ok: string }) {
  const model = new FakeModelInvoker([
    {
      transcript: "Calling flaky tool.",
      toolCalls: [{ toolName: "net/fetch", input: {} }],
    },
    { transcript: "Recovered." },
  ]);
  let calls = 0;
  const tools = new FakeToolInvoker((_toolName: string) => {
    calls += 1;
    const outcome = behavior(_toolName);
    if (outcome instanceof Error) throw outcome;
    return {
      toolCallId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
      toolName: _toolName,
      result: outcome.ok,
      isError: false,
      timestamp: new Date().toISOString() as never,
    };
  });
  const events = new RecordingEventSink();
  const runtime = new AgentRuntime({
    modelInvoker: model,
    toolInvoker: tools,
    eventSink: events,
    memoryProvider: new FakeMemoryProvider(),
    permissionGateway: new FakePermissionGateway(),
  });
  return { runtime, events, getCalls: () => calls };
}

describe("packages/agent-runtime: Retry policy (PR29.12)", () => {
  it("retries exactly once on eligible transient technical failure, then succeeds", async () => {
    let n = 0;
    const { runtime, getCalls } = createRuntimeWithToolBehavior(() => {
      n += 1;
      if (n === 1) throw new Error("Upstream timeout after 30000ms (503)");
      return { ok: "recovered-data" };
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Flaky fetch",
    });

    expect(result.status).toBe("completed");
    expect(getCalls()).toBe(2); // 1 initial + 1 automatic retry
  });

  it("does not retry permission denials", async () => {
    const { runtime, getCalls } = createRuntimeWithToolBehavior(() => {
      throw new Error("Permission denied: blocked by policy");
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Forbidden tool",
    });

    // Permission-denied tool calls block the node; task surfaces blocked-as-failed
    expect(result.status).toBe("failed");
    expect(getCalls()).toBe(1); // zero retries
  });

  it("does not retry semantic failures (malformed input style errors)", async () => {
    const { runtime, getCalls } = createRuntimeWithToolBehavior(() => {
      throw new Error("Semantic failure: missing required field 'path'");
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Bad input tool",
    });

    expect(result.status).toBe("failed");
    expect(getCalls()).toBe(1); // zero retries for semantic failures
  });

  it("gives up after the single automatic retry on persistent transient failures", async () => {
    const { runtime, getCalls, events } = (() => {
      const inner = createRuntimeWithToolBehavior(() => {
        throw new Error("socket hang up (ECONNRESET)");
      });
      return { ...inner, events: undefined as never };
    })();
    void events;

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Always failing",
    });

    expect(result.status).toBe("failed");
    expect(getCalls()).toBe(2); // initial + exactly one retry, never more
  });
});
