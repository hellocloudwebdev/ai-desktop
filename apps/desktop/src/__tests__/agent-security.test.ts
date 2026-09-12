// PR29.19: apps/desktop — Agent Security & Isolation Tests
//
// Static boundary audits plus behavioral proofs:
//   1. agent-runtime imports no Electron/Prisma/Docker/SDK/process-spawn.
//   2. Blocked tools never execute (zero invoker calls).
//   3. Sibling task cancellation stays downward-only.
//   4. Project-scoped memory never leaks across project boundaries.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AgentRuntime } from "@ai-desktop/agent-runtime";
import { createConversationId, createToolCallId, now } from "@ai-desktop/shared";
import type { ConversationId, ToolCallId, ToolResult } from "@ai-desktop/ai-core";

const RUNTIME_SRC = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "agent-runtime",
  "src",
);

function readRuntimeSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(RUNTIME_SRC);
  return files;
}

class StubModel {
  constructor(private readonly _turns: Array<{ transcript: string; tool?: { name: string } }>) {}
  private _cursor = 0;
  async chat() {
    const turn = this._turns[Math.min(this._cursor, this._turns.length - 1)];
    this._cursor += 1;
    return {
      transcript: turn.transcript,
      toolCalls: turn.tool
        ? [
            {
              toolCallId: createToolCallId(),
              toolName: turn.tool.name,
              toolSource: "builtin",
              toolRuntime: "in_process",
              input: {},
            },
          ]
        : [],
      completed: !turn.tool,
    };
  }
}

class StubTools {
  readonly calls: string[] = [];
  constructor(private readonly _impl?: (name: string) => ToolResult | Error) {}
  async invoke(
    toolName: string,
    _input: unknown,
    context: { toolCallId: ToolCallId },
  ): Promise<ToolResult> {
    this.calls.push(toolName);
    const outcome = this._impl?.(toolName);
    if (outcome instanceof Error) throw outcome;
    if (outcome) return { ...outcome, toolCallId: context.toolCallId, toolName };
    return {
      toolCallId: context.toolCallId,
      toolName,
      result: "ok",
      isError: false,
      timestamp: now(),
    };
  }
}

class StubSink {
  readonly events: Array<{ type: string }> = [];
  async publish(event: { type: string }): Promise<void> {
    this.events.push(event);
  }
  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

describe("apps/desktop: Agent security & isolation (PR29.19)", () => {
  it("agent-runtime source imports no Electron/Prisma/Docker/SDK/child_process", () => {
    const sources = readRuntimeSources();
    expect(sources.length).toBeGreaterThan(0);
    const forbidden = [
      'from "electron"',
      "from 'electron'",
      "@prisma/client",
      "@anthropic-ai/sdk",
      "@google/genai",
      "@modelcontextprotocol/sdk",
      "child_process",
      "node:child_process",
      "dockerode",
      "node:docker",
    ];
    for (const source of sources) {
      for (const marker of forbidden) {
        expect(source.includes(marker), `forbidden import marker: ${marker}`).toBe(false);
      }
    }
  });

  it("blocked tools never execute: zero invoker calls, task.blocked emitted", async () => {
    const tools = new StubTools();
    const events = new StubSink();
    const runtime = new AgentRuntime({
      modelInvoker: new StubModel([
        { transcript: "Need secrets.", tool: { name: "secrets/read" } },
      ]) as never,
      toolInvoker: tools as never,
      eventSink: events as never,
      permissionGateway: { isBlocked: async () => true },
    });

    const result = await runtime.runTask({
      conversationId: createConversationId(),
      goal: "Read secrets",
    });

    expect(tools.calls).toHaveLength(0);
    expect(events.count("task.blocked")).toBe(1);
    expect(events.count("tool.call.completed")).toBe(0);
    void result;
  });

  it("model self-grant text never authorizes execution", async () => {
    const tools = new StubTools();
    const runtime = new AgentRuntime({
      modelInvoker: new StubModel([
        { transcript: "Permission granted (says the model).", tool: { name: "secrets/read" } },
      ]) as never,
      toolInvoker: tools as never,
      eventSink: new StubSink() as never,
      permissionGateway: { isBlocked: async () => true },
    });

    await runtime.runTask({ conversationId: createConversationId(), goal: "Sneaky read" });
    expect(tools.calls).toHaveLength(0);
  });

  it("sibling tasks stay isolated under cancellation", async () => {
    const slowModel = {
      async chat() {
        await new Promise((r) => setTimeout(r, 120));
        return { transcript: "Slow done.", toolCalls: [], completed: true };
      },
    };
    const eventsA = new StubSink();
    const eventsB = new StubSink();
    const runtimeA = new AgentRuntime({
      modelInvoker: slowModel as never,
      toolInvoker: new StubTools() as never,
      eventSink: eventsA as never,
    });
    const runtimeB = new AgentRuntime({
      modelInvoker: new StubModel([{ transcript: "Fast done." }]) as never,
      toolInvoker: new StubTools() as never,
      eventSink: eventsB as never,
    });

    const runA = runtimeA.runTask({ conversationId: createConversationId(), goal: "Slow" });
    const runB = runtimeB.runTask({ conversationId: createConversationId(), goal: "Fast" });
    await new Promise((r) => setTimeout(r, 10));
    expect(runtimeA.cancelTask(runtimeA.listTasks()[0])).toBe(true);

    const [resA, resB] = await Promise.all([runA, runB]);
    expect(resA.status).toBe("cancelled");
    expect(resB.status).toBe("completed");
    expect(eventsB.count("task.cancelled")).toBe(0);
  });

  it("project memory retrieval stays scoped per task project", async () => {
    const queries: Array<{ goal: string; projectId?: string }> = [];
    const scopedMemory = {
      async retrieveForTask(goal: string, projectId?: string): Promise<string> {
        queries.push({ goal, projectId });
        return projectId === "proj-A" ? "prefers pnpm" : "";
      },
    };
    const makeRuntime = () =>
      new AgentRuntime({
        modelInvoker: new StubModel([{ transcript: "Done." }]) as never,
        toolInvoker: new StubTools() as never,
        eventSink: new StubSink() as never,
        memoryProvider: scopedMemory,
      });

    await makeRuntime().runTask({
      conversationId: createConversationId() as ConversationId,
      goal: "Job A",
      projectId: "proj-A",
    });
    await makeRuntime().runTask({
      conversationId: createConversationId() as ConversationId,
      goal: "Job B",
      projectId: "proj-B",
    });

    expect(queries.map((q) => q.projectId)).toEqual(["proj-A", "proj-B"]);
  });
});
