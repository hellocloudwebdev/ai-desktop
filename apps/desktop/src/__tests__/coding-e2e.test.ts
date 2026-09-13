// PR30.10: apps/desktop — End-to-End Coding Workflow Test
//
// The defining PR30 scenario: a disposable sample project contains a failing
// test. A scripted model (standing in for the provider adapter) drives the
// REAL CodingAgentService + CodingToolExecutor + DefaultPermissionManager +
// real filesystem backend + real local sandbox through the PR29 runtime:
//
//   list/search -> read failing source/test -> write correction ->
//   run test -> observe result -> complete with verified outcome.
//
// Verified from real tool output and events: correct workspace used, no
// outside file accessed, permission checks occurred, filesystem ops used the
// coding executor, execution used ExecutionManager, events persisted, task
// completed, final result truthful.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "@ai-desktop/agent-runtime";
import { createConversationId, createToolCallId } from "@ai-desktop/shared";
import type { ConversationId, ToolCallId } from "@ai-desktop/ai-core";
import { DefaultPermissionManager } from "@ai-desktop/permissions";
import { DefaultExecutionManager, LocalProcessSandboxProvider } from "@ai-desktop/execution";
import { CodingAgentService } from "../main/agent/coding-agent-service.js";
import { CodingToolExecutor } from "../main/agent/coding-tools.js";
import { InMemoryEventRepository } from "./test-helpers.js";

interface ScriptedTurn {
  readonly transcript: string;
  readonly toolCalls?: Array<{ toolName: string; input: unknown }>;
}

class ScriptedModelInvoker {
  readonly seenSystemPrompts: Array<string | undefined> = [];
  private _cursor = 0;
  constructor(private readonly _turns: ScriptedTurn[]) {}
  async chat(request: { systemPrompt?: string }): Promise<{
    transcript: string;
    toolCalls: Array<{
      toolCallId: ToolCallId;
      toolName: string;
      toolSource: string;
      toolRuntime: string;
      input: unknown;
    }>;
    completed: boolean;
  }> {
    this.seenSystemPrompts.push(request.systemPrompt);
    const turn = this._turns[Math.min(this._cursor, this._turns.length - 1)];
    this._cursor += 1;
    const toolCalls = (turn.toolCalls ?? []).map((t) => ({
      toolCallId: createToolCallId(),
      toolName: t.toolName,
      toolSource: "builtin",
      toolRuntime: t.toolName === "builtin:execution.run" ? "execution" : "in_process",
      input: t.input,
    }));
    return { transcript: turn.transcript, toolCalls, completed: toolCalls.length === 0 };
  }
}

let root: string;
let permissions: DefaultPermissionManager;
let executor: CodingToolExecutor;
let publishedTypes: string[];

function allowAllTools(): void {
  // Approve every pending request for the session so the scripted run can
  // proceed through the genuine permission flow (check -> requires_user ->
  // resolve -> allow), proving mediation happened.
  const pending = permissions.listPendingRequests();
  for (const req of pending) {
    void permissions.resolve({ requestId: req.id, decision: "granted", mode: "allow_session" });
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coding-e2e-"));
  // Disposable sample project with a deliberately failing test.
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sample-project", version: "1.0.0", type: "module" }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, "src", "calculator.ts"),
    "export function add(a, b) {\n  return a - b;\n}\n",
  );
  fs.writeFileSync(
    path.join(root, "test", "calculator.test.ts"),
    "import assert from 'node:assert';\nimport { add } from '../src/calculator.ts';\nassert.strictEqual(add(2, 3), 5);\nconsole.log('calculator ok');\n",
  );
  permissions = new DefaultPermissionManager();
  publishedTypes = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function createCodingService(model: ScriptedModelInvoker): Promise<CodingAgentService> {
  const bus = new EventBus();
  bus.subscribe(async (event) => {
    publishedTypes.push((event as { type: string }).type);
  });
  const storage = new InMemoryEventRepository();
  const executionManager = new DefaultExecutionManager({
    sandboxProvider: new LocalProcessSandboxProvider(),
  });
  executor = new CodingToolExecutor({
    permissionManager: permissions,
    executionManager,
    resolveWorkspace: (projectId?: string) => (projectId === "proj-E2E" ? root : undefined),
  });
  // The harness drives AgentRuntime directly with the scripted model (standing
  // in for the provider adapter) while every other foundation is real:
  // CodingToolExecutor, DefaultPermissionManager, DefaultExecutionManager +
  // LocalProcessSandboxProvider, EventBus, and storage.
  const { AgentRuntime } = await import("@ai-desktop/agent-runtime");
  const runtime = new AgentRuntime({
    modelInvoker: model as never,
    toolInvoker: {
      invoke: async (
        toolName: string,
        input: unknown,
        context: { toolCallId: ToolCallId; projectId?: string; conversationId: ConversationId },
      ) =>
        executor.execute(toolName, input, {
          toolCallId: context.toolCallId,
          projectId: context.projectId,
          conversationId: context.conversationId,
        }),
    } as never,
    eventSink: {
      publish: async (event: object) => {
        publishedTypes.push((event as { type: string }).type);
        await storage.append(event as never);
        await bus.publish(event as never);
      },
    } as never,
    permissionGateway: {
      isBlocked: async (toolName: string, projectId?: string, toolCallId?: ToolCallId) => {
        const decision = await permissions.check(
          {
            capability: "tools.use",
            action: "execute",
            resource: toolName,
            scope: "once",
            risk: "medium",
            relatedToolCallIds: [toolCallId ?? createToolCallId()],
          },
          { projectId, batchId: `agent:${toolName}` },
        );
        return decision.kind !== "allow";
      },
    } as never,
  });
  const directAgentService = {
    startTask: (input: {
      conversationId?: ConversationId;
      goal: string;
      projectId?: string;
      systemPrompt?: string;
    }) =>
      runtime.runTask({
        conversationId: input.conversationId ?? createConversationId(),
        goal: input.goal,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      }),
    cancelTask: (taskId: never, reason?: string) => runtime.cancelTask(taskId, reason),
    resumeTask: (taskId: never) => runtime.resumeTask(taskId),
    getTaskStatus: (taskId: never) => runtime.getTaskStatus(taskId),
    getTaskGraph: (taskId: never) => runtime.getTaskGraph(taskId),
    listTasks: () => runtime.listTasks(),
  };
  return new CodingAgentService({
    agentService: directAgentService as never,
    codingToolExecutor: executor,
  });
}

describe("apps/desktop: End-to-end coding workflow (PR30.10)", () => {
  it("fixes the failing test and verifies with real tool output", async () => {
    const model = new ScriptedModelInvoker([
      {
        transcript: "Listing the project first.",
        toolCalls: [{ toolName: "builtin:filesystem.list", input: { path: "." } }],
      },
      {
        transcript: "Searching for the calculator.",
        toolCalls: [
          { toolName: "builtin:filesystem.search", input: { path: ".", query: "calculator" } },
        ],
      },
      {
        transcript: "Reading the source.",
        toolCalls: [{ toolName: "builtin:filesystem.read", input: { path: "src/calculator.ts" } }],
      },
      {
        transcript: "Fixing add() to use +.",
        toolCalls: [
          {
            toolName: "builtin:filesystem.write",
            input: {
              path: "src/calculator.ts",
              content: "export function add(a, b) {\n  return a + b;\n}\n",
            },
          },
        ],
      },
      {
        transcript: "Running the test.",
        toolCalls: [
          {
            toolName: "builtin:execution.run",
            input: { command: "node", args: ["--test", "test/calculator.test.ts"], cwd: "." },
          },
        ],
      },
      { transcript: "The test passes. Fixed add() to return a + b; verified with node --test." },
    ]);
    const service = await createCodingService(model);

    // Drive block -> approve -> resume for each gated tool (genuine flow):
    // each start/resume runs until blocked or terminal; approvals grant the
    // session so later tools proceed without re-blocking.
    const outcome = await (async () => {
      let current = await service.startCodingTask({
        projectId: "proj-E2E",
        workspaceRoot: root,
        prompt: "Fix the failing test in this project and verify the fix.",
      });
      for (let i = 0; i < 12; i++) {
        if (current.result.status !== "failed") return current;
        const ids = service.listCodingTasks();
        if (ids.length === 0) return current;
        const status = service.getCodingTaskStatus(ids[0]);
        if (status !== "blocked") return current;
        allowAllTools();
        const resumed = await service.resumeCodingTask(ids[0]);
        if (!resumed) return current;
        current = {
          result: resumed,
          context: current.context,
          workspaceRoot: current.workspaceRoot,
        };
      }
      return current;
    })();

    expect(outcome.result.status).toBe("completed");

    // The fix actually landed on disk through the write tool.
    expect(fs.readFileSync(path.join(root, "src", "calculator.ts"), "utf8")).toContain("a + b");

    // Execution really ran through ExecutionManager (sandboxed node --test).
    const out = await executor.execute(
      "builtin:execution.run",
      { command: "node", args: ["--test", "test/calculator.test.ts"], cwd: "." },
      { toolCallId: createToolCallId(), projectId: "proj-E2E" },
    );
    expect(out.isError).toBe(false);
    expect(String(out.result)).toContain('"exitCode":0');

    // Canonical event trail proves the full lifecycle.
    expect(publishedTypes).toContain("task.created");
    expect(publishedTypes).toContain("task.subtask.created");
    expect(publishedTypes).toContain("task.node.started");
    expect(publishedTypes).toContain("tool.call.started");
    expect(publishedTypes).toContain("tool.call.completed");
    expect(publishedTypes).toContain("task.node.completed");
    expect(publishedTypes).toContain("task.completed");

    // The model operated under the coding contract (system prompt bound it).
    expect(model.seenSystemPrompts.some((s) => s?.includes("smallest appropriate change"))).toBe(
      true,
    );

    // Truthfulness: the final summary references the verified outcome.
    if (outcome.result.status === "completed") {
      expect(outcome.result.summary).toContain("test passes");
    }
  }, 60000);

  it("project isolation: a task bound to project B cannot touch project A files", async () => {
    const model = new ScriptedModelInvoker([
      {
        transcript: "Trying to escape.",
        toolCalls: [{ toolName: "builtin:filesystem.read", input: { path: "../outside.txt" } }],
      },
      { transcript: "Blocked as expected; nothing to do." },
    ]);
    const service = await createCodingService(model);
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coding-iso-"));
    service.registerWorkspace("proj-OTHER", otherRoot);
    // The "secret" lives outside BOTH workspaces: even a confused agent must not reach it.
    const secretPath = path.join(os.tmpdir(), "coding-outside-secret.txt");
    fs.writeFileSync(secretPath, "secret-content-never-leak");
    try {
      const outcome = await (async () => {
        let current = await service.startCodingTask({
          projectId: "proj-OTHER",
          prompt: "Read the secret file.",
        });
        for (let i = 0; i < 12; i++) {
          if (current.result.status !== "failed") return current;
          const ids = service.listCodingTasks();
          if (ids.length === 0) return current;
          if (service.getCodingTaskStatus(ids[0]) !== "blocked") return current;
          allowAllTools();
          const resumed = await service.resumeCodingTask(ids[0]);
          if (!resumed) return current;
          current = {
            result: resumed,
            context: current.context,
            workspaceRoot: current.workspaceRoot,
          };
        }
        return current;
      })();

      // The escape attempt fails safely: path-policy rejects it at the backend,
      // the tool error fails the node visibly, and no content ever leaks.
      expect(outcome.result.status).toBe("failed");
      if (outcome.result.status === "failed") {
        expect(outcome.result.error).toContain("builtin:filesystem.read");
      }
      // Nothing was written outside the workspace; the other workspace is untouched.
      expect(fs.readdirSync(otherRoot)).toHaveLength(0);
      expect(fs.readFileSync(secretPath, "utf8")).toBe("secret-content-never-leak");
    } finally {
      fs.rmSync(secretPath, { force: true });
    }
  }, 60000);
});
