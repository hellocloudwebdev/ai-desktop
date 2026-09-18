// PR43: packages/agent-runtime — Background recovery tests
//
// Recovery preserves identity, never auto-executes tool side effects, and is
// idempotent. Persisted intent ≠ external side effect: uncertain operations
// surface as requires_approval; non-idempotent tools are never auto-replayed.

import { describe, expect, it } from "vitest";
import { createConversationId, createTaskId } from "@ai-desktop/shared";
import type { BackgroundTaskRecord } from "@ai-desktop/ai-core";
import {
  BackgroundTaskManager,
  isBackgroundManagerError,
  type BackgroundRuntimeDelegate,
} from "../runtime/background-task-manager.js";
import type { AgentTaskResult, AgentTaskStatus, RunTaskInput } from "../runtime/types.js";
import type { TaskId } from "@ai-desktop/shared";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

class RecordingSink {
  readonly events: { type: string }[] = [];
  async publish(event: { type: string }): Promise<void> {
    this.events.push({ type: event.type });
  }
  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

class CountingRuntime implements BackgroundRuntimeDelegate {
  runCalls = 0;
  async runTask(input: RunTaskInput): Promise<AgentTaskResult> {
    void input;
    this.runCalls += 1;
    return { status: "completed", taskId: createTaskId(), summary: "ok" };
  }
  cancelTask(taskId: TaskId): boolean {
    void taskId;
    return true;
  }
  async resumeTask(taskId: TaskId): Promise<AgentTaskResult | null> {
    void taskId;
    return null;
  }
  getTaskStatus(): AgentTaskStatus | undefined {
    return undefined;
  }
  getTaskGraph(): unknown {
    return undefined;
  }
  listTasks(): TaskId[] {
    return [];
  }
}

function makeRecord(overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  const ts = new Date().toISOString();
  return {
    taskId: createTaskId(),
    conversationId: createConversationId(),
    projectId: "proj-a",
    title: "Nightly job",
    goal: "Rebuild the index",
    mode: "background",
    status: "queued",
    createdAt: ts,
    updatedAt: ts,
    attempt: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("BackgroundTaskManager.recover: classification", () => {
  it("requeues fresh queued/running as resumable without auto-executing", async () => {
    const runtime = new CountingRuntime();
    const sink = new RecordingSink();
    const manager = new BackgroundTaskManager({ runtime, eventSink: sink as never });
    const summary = await manager.recover([
      makeRecord({ status: "queued", attempt: 0 }),
      makeRecord({ status: "running", attempt: 1 }),
    ]);
    expect(summary).toEqual({ resumed: 2, awaitingApproval: 0, abandoned: 0, rejected: 0 });
    expect(runtime.runCalls).toBe(0);
    expect(sink.count("task.background.recovered")).toBe(2);
    expect(manager.queuedCount()).toBe(2);
    // Preserves identity: recovered ids are fetchable.
    for (const p of manager.list()) {
      const got = manager.get(p.taskId, "proj-a");
      expect(isBackgroundManagerError(got)).toBe(false);
    }
  });

  it("parks retried and waiting states as requires_approval snapshots", async () => {
    const runtime = new CountingRuntime();
    const sink = new RecordingSink();
    const manager = new BackgroundTaskManager({ runtime, eventSink: sink as never });
    const summary = await manager.recover([
      makeRecord({ status: "running", attempt: 3 }),
      makeRecord({ status: "waiting_permission", attempt: 0 }),
      makeRecord({ status: "waiting_input", attempt: 0 }),
      makeRecord({ status: "paused", attempt: 0 }),
    ]);
    expect(summary).toEqual({ resumed: 0, awaitingApproval: 4, abandoned: 0, rejected: 0 });
    expect(runtime.runCalls).toBe(0);
    expect(sink.count("task.background.recovered")).toBe(4);
    // Uncertain running requeues as paused (never auto-running).
    const statuses = manager
      .list()
      .map((p) => p.status)
      .sort();
    expect(statuses).toContain("paused");
    expect(statuses).toContain("waiting_permission");
    expect(statuses).toContain("waiting_input");
    expect(manager.activeCount()).toBe(2); // waiting_* still hold slots; paused does not
  });

  it("ignores terminal records as abandoned", async () => {
    const runtime = new CountingRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const summary = await manager.recover([
      makeRecord({ status: "completed" }),
      makeRecord({ status: "failed" }),
      makeRecord({ status: "cancelled" }),
    ]);
    expect(summary).toEqual({ resumed: 0, awaitingApproval: 0, abandoned: 3, rejected: 0 });
    expect(manager.size).toBe(0);
    expect(runtime.runCalls).toBe(0);
  });

  it("rejects malformed records without executing", async () => {
    const runtime = new CountingRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const good = makeRecord({ status: "queued" });
    const summary = await manager.recover([
      good,
      { ...good, taskId: "not-a-ulid" },
      { nope: true },
      null,
    ]);
    expect(summary.rejected).toBe(3);
    expect(summary.resumed).toBe(1);
    expect(runtime.runCalls).toBe(0);
  });

  it("rejects secret-bearing persisted payloads (corrupted state never executes)", async () => {
    const runtime = new CountingRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const summary = await manager.recover([
      makeRecord({ status: "queued", goal: "leak api_key=sk-123" }),
    ]);
    expect(summary.rejected).toBe(1);
    expect(summary.resumed).toBe(0);
    expect(runtime.runCalls).toBe(0);
    expect(manager.size).toBe(0);
  });

  it("dedupes by taskId keeping the first", async () => {
    const runtime = new CountingRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const id = createTaskId();
    const first = makeRecord({ taskId: id, status: "queued", title: "first" });
    const dup = makeRecord({ taskId: id, status: "queued", title: "second" });
    const summary = await manager.recover([first, dup]);
    expect(summary.resumed).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(manager.size).toBe(1);
    const got = manager.get(id, "proj-a");
    if (isBackgroundManagerError(got)) throw new Error("missing");
    expect(got.record.title).toBe("first");
  });

  it("is idempotent: same input twice yields the same summary with no duplicates", async () => {
    const runtime = new CountingRuntime();
    const sink = new RecordingSink();
    const manager = new BackgroundTaskManager({ runtime, eventSink: sink as never });
    const records = [
      makeRecord({ status: "queued", attempt: 0 }),
      makeRecord({ status: "waiting_input", attempt: 0 }),
      makeRecord({ status: "completed" }),
      { bad: true },
    ];
    const first = await manager.recover(records as never[]);
    const sizeAfterFirst = manager.size;
    const recoveredAfterFirst = sink.count("task.background.recovered");
    const second = await manager.recover(records as never[]);
    expect(second).toEqual(first);
    expect(manager.size).toBe(sizeAfterFirst);
    // No duplicate entries and no re-emission on replay.
    expect(sink.count("task.background.recovered")).toBe(recoveredAfterFirst);
    expect(runtime.runCalls).toBe(0);
  });

  it("never reuses taskIds: recovered identity is preserved on later starts", async () => {
    const runtime = new CountingRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const persisted = makeRecord({ status: "queued" });
    await manager.recover([persisted]);
    const started = await manager.start({ projectId: "proj-a", goal: "fresh work" });
    if (isBackgroundManagerError(started)) throw new Error("start failed");
    expect(started.record.taskId).not.toBe(persisted.taskId);
    await flush();
  });
});
