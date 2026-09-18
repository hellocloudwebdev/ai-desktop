// PR43: apps/desktop — DesktopBackgroundTaskService Tests
//
// Thin-orchestration coverage: start->queued->running, caps, project guards,
// pause/resume, cancel idempotency, permission/input parking, recovery
// semantics, secret refusal, and renderer-disconnect safety. No Electron is
// needed anywhere in this suite.

import { describe, expect, it } from "vitest";
import type { AgentTaskResult } from "@ai-desktop/agent-runtime";
import type { AIEvent, ConversationId, TaskId } from "@ai-desktop/ai-core";
import type { BackgroundTaskRow } from "@ai-desktop/storage";
import { createConversationId, createTaskId } from "@ai-desktop/shared";
import { DesktopBackgroundTaskService } from "../background-task-service.js";

type DelegateMode = "immediate" | "pending" | "blocked" | "gated";

class StubAgentService {
  mode: DelegateMode = "immediate";
  resumeResult: AgentTaskResult | null = null;
  readonly started: Array<{ goal: string; projectId?: string }> = [];
  readonly cancelled: string[] = [];
  readonly resumed: string[] = [];
  private readonly gateResolvers: Array<(result: AgentTaskResult) => void> = [];

  async startTask(input: {
    conversationId?: ConversationId;
    goal: string;
    projectId?: string;
  }): Promise<AgentTaskResult> {
    this.started.push({ goal: input.goal, projectId: input.projectId });
    if (this.mode === "pending") {
      return new Promise<AgentTaskResult>(() => {});
    }
    if (this.mode === "gated") {
      return new Promise<AgentTaskResult>((resolve) => {
        this.gateResolvers.push(resolve);
      });
    }
    if (this.mode === "blocked") {
      return {
        status: "failed",
        taskId: createTaskId(),
        error: "Task blocked awaiting approval",
      };
    }
    return { status: "completed", taskId: createTaskId(), summary: `done: ${input.goal}` };
  }

  /** Resolves the oldest gated run as completed. */
  resolveNextGated(summary = "gated work finished"): void {
    const resolve = this.gateResolvers.shift();
    resolve?.({ status: "completed", taskId: createTaskId(), summary });
  }

  cancelTask(taskId: TaskId): boolean {
    this.cancelled.push(String(taskId));
    return true;
  }

  async resumeTask(taskId: TaskId): Promise<AgentTaskResult | null> {
    this.resumed.push(String(taskId));
    return this.resumeResult;
  }

  listTasks(): TaskId[] {
    return [];
  }
}

class InMemoryBackgroundStore {
  readonly rows = new Map<string, BackgroundTaskRow>();

  async upsert(record: BackgroundTaskRow): Promise<void> {
    this.rows.set(record.taskId, { ...record });
  }

  async get(taskId: string): Promise<BackgroundTaskRow | null> {
    return this.rows.get(taskId) ?? null;
  }

  async listByProject(projectId: string): Promise<BackgroundTaskRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async listUnfinished(): Promise<BackgroundTaskRow[]> {
    return [...this.rows.values()].filter(
      (row) => row.status !== "completed" && row.status !== "failed" && row.status !== "cancelled",
    );
  }
}

class StubEventBus {
  readonly events: AIEvent[] = [];

  async publish(event: Readonly<AIEvent>): Promise<void> {
    this.events.push(event as AIEvent);
  }

  count(type: string): number {
    return this.events.filter((event) => (event as { type: string }).type === type).length;
  }
}

class StubEventRepository {
  readonly appended: AIEvent[] = [];

  async append(event: Readonly<AIEvent>): Promise<void> {
    this.appended.push(event as AIEvent);
  }

  async getByConversation(conversationId: ConversationId): Promise<AIEvent[]> {
    return this.appended.filter((event) => event.conversationId === conversationId);
  }
}

function createHarness() {
  const agents = new StubAgentService();
  const store = new InMemoryBackgroundStore();
  const bus = new StubEventBus();
  const storage = new StubEventRepository();
  const service = new DesktopBackgroundTaskService({
    agentService: agents,
    backgroundTasks: store,
    eventBus: bus,
    storage,
  });
  return { agents, store, bus, storage, service };
}

async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeRow(overrides: Partial<BackgroundTaskRow> = {}): BackgroundTaskRow {
  const timestamp = Date.now();
  return {
    taskId: createTaskId(),
    conversationId: createConversationId(),
    projectId: "proj-r",
    title: "Seeded background work",
    goal: "Rebuild the project search index",
    mode: "background",
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
    attempt: 0,
    lastError: null,
    resultSummary: null,
    nodeCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("desktop: DesktopBackgroundTaskService (PR43)", () => {
  it("start persists a queued projection, emits queued+started, and delegates with the original projectId", async () => {
    const { agents, store, bus, storage, service } = createHarness();
    agents.mode = "gated";
    const task = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });

    expect(task.status).toBe("running");
    expect(task.mode).toBe("background");
    expect(task.projectId).toBe("proj-a");
    expect(bus.count("task.background.queued")).toBe(1);
    expect(bus.count("task.background.started")).toBe(1);
    // Events are authoritative: storage.append precedes EventBus.publish.
    expect(storage.appended.length).toBe(bus.events.length);

    const row = await store.get(task.taskId);
    expect(row?.status).toBe("running");
    expect(row?.mode).toBe("background");
    expect(row?.schemaVersion).toBe(1);
    expect(agents.started).toHaveLength(1);
    expect(agents.started[0]?.projectId).toBe("proj-a");

    agents.resolveNextGated(`done: ${task.taskId}`);
    await settle();
    const done = await service.get(task.taskId, "proj-a");
    expect(done.status).toBe("completed");
    expect(done.resultSummary).toContain("done:");
    expect(bus.count("task.background.completed")).toBe(1);
    // Renderer-safe projection: no goal text or conversation id leaks.
    expect((done as unknown as Record<string, unknown>).goal).toBeUndefined();
    expect((done as unknown as Record<string, unknown>).conversationId).toBeUndefined();
  });

  it("rejects start when the queue is full (16 queued) without invoking the delegate", async () => {
    const { agents, service } = createHarness();
    agents.mode = "pending";
    for (let i = 0; i < 4; i += 1) {
      const task = await service.start({
        projectId: `proj-run-${i}`,
        goal: `Running work item ${i}`,
      });
      expect(task.status).toBe("running");
    }
    for (let i = 0; i < 16; i += 1) {
      const task = await service.start({ projectId: "proj-q", goal: `Queued work item ${i}` });
      expect(task.status).toBe("queued");
    }
    const startedBefore = agents.started.length;
    await expect(
      service.start({ projectId: "proj-q", goal: "One overflowing work item" }),
    ).rejects.toThrow("queue-full");
    expect(agents.started.length).toBe(startedBefore);
  });

  it("enforces per-project running caps (2) while other projects still schedule", async () => {
    // Use a pending delegate for deterministic scheduling.
    const harness = createHarness();
    harness.agents.mode = "pending";
    const a1 = await harness.service.start({ projectId: "proj-a", goal: "Alpha first item" });
    const a2 = await harness.service.start({ projectId: "proj-a", goal: "Alpha second item" });
    const a3 = await harness.service.start({ projectId: "proj-a", goal: "Alpha third item" });
    const b1 = await harness.service.start({ projectId: "proj-b", goal: "Beta first item" });
    expect(a1.status).toBe("running");
    expect(a2.status).toBe("running");
    expect(a3.status).toBe("queued");
    expect(b1.status).toBe("running");
  });

  it("denies cross-project reads and mutations with project-mismatch", async () => {
    const { service } = createHarness();
    const task = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });

    await expect(service.get(task.taskId, "proj-b")).rejects.toThrow("project-mismatch");
    await expect(service.pause(task.taskId, "proj-b")).rejects.toThrow("project-mismatch");
    await expect(service.resume(task.taskId, "proj-b")).rejects.toThrow("project-mismatch");
    await expect(service.cancel(task.taskId, "proj-b")).rejects.toThrow("project-mismatch");
    await expect(service.respond(task.taskId, "proj-b", "hello")).rejects.toThrow(
      "project-mismatch",
    );
    await expect(service.get("01JZZZZZZZZZZZZZZZZZZZZZZ", "proj-a")).rejects.toThrow("not-found");
  });

  it("pause parks a running task and resume requeues it through the delegate", async () => {
    const { agents, bus, service } = createHarness();
    agents.mode = "pending";
    const task = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });

    const paused = await service.pause(task.taskId, "proj-a");
    expect(paused.status).toBe("paused");
    expect(bus.count("task.background.paused")).toBe(1);
    expect(agents.cancelled).toHaveLength(1);
    await expect(service.pause(task.taskId, "proj-a")).rejects.toThrow("invalid-transition");

    const resumed = await service.resume(task.taskId, "proj-a");
    expect(resumed.status).toBe("running");
    expect(resumed.attempt).toBe(2);
    expect(bus.count("task.background.resumed")).toBe(1);
    expect(agents.started.length).toBe(2);
  });

  it("rejects pausing a queued task (queued->paused is an illegal transition)", async () => {
    const harness = createHarness();
    harness.agents.mode = "pending";
    for (let i = 0; i < 4; i += 1) {
      await harness.service.start({ projectId: `proj-run-${i}`, goal: `Running work item ${i}` });
    }
    const queued = await harness.service.start({ projectId: "proj-q", goal: "Queued work item" });
    expect(queued.status).toBe("queued");
    await expect(harness.service.pause(queued.taskId, "proj-q")).rejects.toThrow(
      "invalid-transition",
    );
  });

  it("cancel is idempotent and terminal tasks report cancelled:false", async () => {
    const { bus, service } = createHarness();
    const pendingHarness = createHarness();
    pendingHarness.agents.mode = "pending";
    const task = await pendingHarness.service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });

    const first = await pendingHarness.service.cancel(task.taskId, "proj-a", "no longer needed");
    expect(first.cancelled).toBe(true);
    expect(first.task.status).toBe("cancelled");
    const second = await pendingHarness.service.cancel(task.taskId, "proj-a");
    expect(second.cancelled).toBe(true);
    expect(second.task.status).toBe("cancelled");
    expect(pendingHarness.bus.count("task.background.cancelled")).toBe(1);

    const quick = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });
    await settle();
    const terminal = await service.cancel(quick.taskId, "proj-a");
    expect(terminal.cancelled).toBe(false);
    expect(terminal.task.status).toBe("completed");
    expect(bus.count("task.background.cancelled")).toBe(0);
  });

  it("parks waiting_permission on blocked delegate output and replays the exact op on approval", async () => {
    const { agents, bus, service } = createHarness();
    agents.mode = "blocked";
    const task = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });
    await settle();

    const parked = await service.get(task.taskId, "proj-a");
    expect(parked.status).toBe("waiting_permission");
    expect(bus.count("task.background.waiting_permission")).toBe(1);

    agents.resumeResult = {
      status: "completed",
      taskId: createTaskId(),
      summary: "approved work finished",
    };
    const resumed = await service.resume(task.taskId, "proj-a");
    expect(agents.resumed).toHaveLength(1);
    expect(resumed.status).toBe("completed");
    expect(resumed.resultSummary).toBe("approved work finished");
  });

  it("falls back to a fresh delegated run when a stale approval no longer resolves", async () => {
    const { agents, service } = createHarness();
    agents.mode = "pending";
    const task = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });
    await service.parkWaiting(task.taskId, "waiting_permission", "Allow the pending write");

    agents.resumeResult = null;
    agents.mode = "immediate";
    const resumed = await service.resume(task.taskId, "proj-a");
    expect(resumed.status).toBe("running");
    // Initial run + one fresh delegated run after the stale approval.
    expect(agents.started.length).toBe(2);
  });

  it("parks waiting_input with the request prompt and resumes on respond", async () => {
    const { agents, bus, service } = createHarness();
    agents.mode = "pending";
    const task = await service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });
    await service.parkWaiting(task.taskId, "waiting_input", "Which host should be used?");
    expect(bus.count("task.background.waiting_input")).toBe(1);

    agents.resumeResult = {
      status: "completed",
      taskId: createTaskId(),
      summary: "answered follow-up",
    };
    const answered = await service.respond(task.taskId, "proj-a", "Use the primary host");
    expect(answered.status).toBe("completed");
    await expect(service.respond(task.taskId, "proj-a", "again")).rejects.toThrow(
      "invalid-transition",
    );
    await expect(service.respond(task.taskId, "proj-a", "")).rejects.toThrow("validation-error");
    await expect(service.respond(task.taskId, "proj-a", "x".repeat(2001))).rejects.toThrow(
      "validation-error",
    );
  });

  it("refuses secret-bearing input on respond without mutating state", async () => {
    const pendingHarness = createHarness();
    pendingHarness.agents.mode = "pending";
    const task = await pendingHarness.service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });
    await pendingHarness.service.parkWaiting(
      task.taskId,
      "waiting_input",
      "Which host should be used?",
    );
    await expect(
      pendingHarness.service.respond(task.taskId, "proj-a", "api_key=SHOULD-NOT-PERSIST"),
    ).rejects.toThrow("secret-refused");
    const still = await pendingHarness.service.get(task.taskId, "proj-a");
    expect(still.status).toBe("waiting_input");
  });

  it("refuses secret-bearing goals and cancel reasons without persisting", async () => {
    const { store, bus, service } = createHarness();
    await expect(
      service.start({ projectId: "proj-a", goal: "Rotate the api_key value immediately" }),
    ).rejects.toThrow("secret-refused");
    expect(store.rows.size).toBe(0);
    expect(bus.events).toHaveLength(0);

    const pendingHarness = createHarness();
    pendingHarness.agents.mode = "pending";
    const task = await pendingHarness.service.start({
      projectId: "proj-a",
      goal: "Rebuild the project search index",
    });
    await expect(
      pendingHarness.service.cancel(task.taskId, "proj-a", "contains api_key material"),
    ).rejects.toThrow("secret-refused");
    const still = await pendingHarness.service.get(task.taskId, "proj-a");
    expect(still.status).toBe("running");
  });

  it("recoverUnfinishedOnStartup requeues resumable work and parks the rest without executing it", async () => {
    const { agents, store, bus, service } = createHarness();
    const resumable = makeRow({ projectId: "proj-r", status: "queued", attempt: 0 });
    const staleRunning = makeRow({ projectId: "proj-r", status: "running", attempt: 5 });
    const parkedPermission = makeRow({
      projectId: "proj-r",
      status: "waiting_permission",
      attempt: 0,
    });
    const paused = makeRow({ projectId: "proj-r", status: "paused", attempt: 0 });
    const malformedAddressable = makeRow({ projectId: "proj-r", status: "exploding" as never });
    const malformedSilent = makeRow({ projectId: "proj-r", taskId: "not-a-ulid" });
    for (const row of [
      resumable,
      staleRunning,
      parkedPermission,
      paused,
      malformedAddressable,
      malformedSilent,
    ]) {
      await store.upsert(row as BackgroundTaskRow);
    }

    const summary = await service.recoverUnfinishedOnStartup();
    expect(summary).toEqual({
      recovered: 4,
      resumable: 1,
      requiresApproval: 3,
      rejected: 2,
      ignored: 0,
    });
    await settle();

    // Only the resumable row executed; parked rows never auto-run.
    expect(agents.started).toHaveLength(1);
    expect(agents.started[0]?.goal).toBe(resumable.goal);
    expect((await service.get(resumable.taskId, "proj-r")).status).toBe("completed");

    // Attempt>1 running work is parked (paused), never resumed blindly.
    expect((await service.get(staleRunning.taskId, "proj-r")).status).toBe("paused");
    expect((await service.get(parkedPermission.taskId, "proj-r")).status).toBe(
      "waiting_permission",
    );
    expect((await service.get(paused.taskId, "proj-r")).status).toBe("paused");
    expect(bus.count("task.background.recovered")).toBe(5);

    // Idempotent: a second pass produces no new effects.
    const again = await service.recoverUnfinishedOnStartup();
    expect(again).toEqual({
      recovered: 0,
      resumable: 0,
      requiresApproval: 0,
      rejected: 0,
      ignored: 0,
    });
    expect(agents.started).toHaveLength(1);
    expect(bus.count("task.background.recovered")).toBe(5);
  });

  it("recovery ignores abandoned rows without emitting or executing", async () => {
    const finishedAt = Date.now();
    const finished = makeRow({
      projectId: "proj-r",
      status: "completed",
      completedAt: finishedAt,
    });
    const harness = createHarness();
    harness.store.listUnfinished = async () => [finished];
    const summary = await harness.service.recoverUnfinishedOnStartup();
    expect(summary).toEqual({
      recovered: 0,
      resumable: 0,
      requiresApproval: 0,
      rejected: 0,
      ignored: 1,
    });
    expect(harness.agents.started).toHaveLength(0);
    expect(harness.bus.events).toHaveLength(0);
  });

  it("lists only the caller project (project isolation on reads)", async () => {
    const pendingHarness = createHarness();
    pendingHarness.agents.mode = "pending";
    await pendingHarness.service.start({ projectId: "proj-a", goal: "Alpha work item" });
    await pendingHarness.service.start({ projectId: "proj-b", goal: "Beta work item" });

    const listed = await pendingHarness.service.list("proj-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.projectId).toBe("proj-a");
  });

  it("operates with no renderer/WebContents state as source of truth", async () => {
    // No registry, WebContents, or window exists in this suite by
    // construction; the full start->pause->resume->cancel flow must work.
    const harness = createHarness();
    harness.agents.mode = "pending";
    const task = await harness.service.start({ projectId: "proj-a", goal: "Detached work item" });
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    await harness.service.pause(task.taskId, "proj-a");
    await harness.service.resume(task.taskId, "proj-a");
    const outcome = await harness.service.cancel(task.taskId, "proj-a");
    expect(outcome.cancelled).toBe(true);
    expect(outcome.task.status).toBe("cancelled");
  });
});
