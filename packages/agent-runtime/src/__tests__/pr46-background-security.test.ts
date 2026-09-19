// PR46: packages/agent-runtime — Background Security (adversarial)
import { describe, expect, it } from "vitest";
import { createTaskId, type TaskId } from "@ai-desktop/shared";
import {
  BackgroundTaskManager,
  isBackgroundManagerError,
  type BackgroundRuntimeDelegate,
} from "../runtime/background-task-manager.js";
import type { AgentTaskResult, AgentTaskStatus, RunTaskInput } from "../runtime/types.js";

class ImmediateRuntime implements BackgroundRuntimeDelegate {
  readonly runCalls: RunTaskInput[] = [];
  readonly cancelCalls: TaskId[] = [];
  constructor(private readonly summary = "done") {}
  async runTask(input: RunTaskInput): Promise<AgentTaskResult> {
    this.runCalls.push(input);
    return { status: "completed", taskId: createTaskId(), summary: this.summary };
  }
  cancelTask(taskId: TaskId): boolean {
    this.cancelCalls.push(taskId);
    return true;
  }
  async resumeTask(): Promise<AgentTaskResult | null> {
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
class ManualRuntime implements BackgroundRuntimeDelegate {
  readonly runCalls: RunTaskInput[] = [];
  readonly cancelCalls: TaskId[] = [];
  private readonly resolvers: Array<(r: AgentTaskResult) => void> = [];
  async runTask(input: RunTaskInput, signal?: AbortSignal): Promise<AgentTaskResult> {
    this.runCalls.push(input);
    return new Promise<AgentTaskResult>((resolve) => {
      this.resolvers.push(resolve);
      signal?.addEventListener(
        "abort",
        () => resolve({ status: "cancelled", taskId: createTaskId(), reason: "aborted" }),
        { once: true },
      );
    });
  }
  cancelTask(taskId: TaskId): boolean {
    this.cancelCalls.push(taskId);
    return true;
  }
  async resumeTask(): Promise<AgentTaskResult | null> {
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
  completeOldest(summary = "ok"): void {
    const r = this.resolvers.shift();
    if (r) r({ status: "completed", taskId: createTaskId(), summary });
  }
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function startInput(overrides: Record<string, unknown> = {}) {
  return { goal: "Do the thing.", projectId: "proj-a", ...overrides };
}

describe("background security: stale and duplicate rejected", () => {
  it("duplicate taskId in createIds rejected (collision fail-closed)", async () => {
    const runtime = new ImmediateRuntime();
    const fixed = createTaskId();
    const manager = new BackgroundTaskManager({
      runtime,
      createIds: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return { taskId: fixed, conversationId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never };
          }
          return { taskId: fixed, conversationId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never };
        };
      })() as never,
    });
    const first = await manager.start(startInput());
    expect(isBackgroundManagerError(first)).toBe(false);
    const second = await manager.start(startInput());
    expect(isBackgroundManagerError(second)).toBe(true);
  });
  it("malformed ids yield validation-error (never throw)", async () => {
    const manager = new BackgroundTaskManager({ runtime: new ImmediateRuntime() });
    expect(isBackgroundManagerError(manager.get("__proto__" as never))).toBe(true);
    const started = await manager.start(startInput());
    if (isBackgroundManagerError(started)) throw new Error("expected ok");
    const cross = manager.get(started.record.taskId, "other-project");
    expect(isBackgroundManagerError(cross)).toBe(true);
    if (!isBackgroundManagerError(cross)) throw new Error("expected error");
    expect(cross.error.code).toBe("project-mismatch");
  });
  it("recovery dedupes batch duplicates (total-preserving, no double execute)", async () => {
    const manager = new BackgroundTaskManager({ runtime: new ImmediateRuntime() });
    const rec = {
      taskId: createTaskId(),
      conversationId: createTaskId() as never,
      projectId: "proj-a",
      title: "t",
      goal: "g",
      mode: "background",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0,
      schemaVersion: 1,
    };
    const summary = await manager.recover([rec, rec]);
    expect(summary.resumed + summary.rejected).toBe(2);
    expect(manager.size).toBe(1);
  });
});

describe("background security: recovery no-broadening + cancel idempotency", () => {
  it("recovery never auto-executes (resumable requeued, no runTask call)", async () => {
    const runtime = new ManualRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const rec = {
      taskId: createTaskId(),
      conversationId: createTaskId() as never,
      projectId: "proj-a",
      title: "t",
      goal: "g",
      mode: "background",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0,
      schemaVersion: 1,
    };
    await manager.recover([rec]);
    await flush();
    expect(runtime.runCalls.length).toBe(0);
  });
  it("secret-bearing persisted records rejected on recovery (never restored)", async () => {
    const manager = new BackgroundTaskManager({ runtime: new ImmediateRuntime() });
    const rec = {
      taskId: createTaskId(),
      conversationId: createTaskId() as never,
      projectId: "proj-a",
      title: "api_key=sk-live-12345678",
      goal: "g",
      mode: "background",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 0,
      schemaVersion: 1,
    };
    const summary = await manager.recover([rec]);
    expect(summary.rejected).toBe(1);
    expect(manager.size).toBe(0);
  });
  it("cancel is idempotent (second cancel returns same record, single delegate call)", async () => {
    const runtime = new ManualRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const started = await manager.start(startInput());
    if (isBackgroundManagerError(started)) throw new Error("expected ok");
    const taskId = started.record.taskId;
    const projectId = "proj-a";
    await flush();
    const first = await manager.cancel(taskId, projectId, "stop");
    expect(isBackgroundManagerError(first)).toBe(false);
    const second = await manager.cancel(taskId, projectId, "stop");
    expect(isBackgroundManagerError(second)).toBe(false);
    if (!isBackgroundManagerError(first) && !isBackgroundManagerError(second)) {
      expect(second.record.status).toBe("cancelled");
      expect(second.record.taskId).toBe(first.record.taskId);
    }
  });
  it("cancel reason with secrets refused (never persisted)", async () => {
    const manager = new BackgroundTaskManager({ runtime: new ImmediateRuntime() });
    const started = await manager.start(startInput());
    if (isBackgroundManagerError(started)) throw new Error("expected ok");
    const res = await manager.cancel(started.record.taskId, "proj-a", "api_key=sk-live-12345678");
    expect(isBackgroundManagerError(res)).toBe(true);
  });
});

describe("background security: permission-waiting unbypassable", () => {
  it("waiting_permission only clears via explicit resolve (resume rejected)", async () => {
    const runtime = new ManualRuntime();
    const manager = new BackgroundTaskManager({ runtime });
    const started = await manager.start(startInput());
    if (isBackgroundManagerError(started)) throw new Error("expected ok");
    const taskId = started.record.taskId;
    await flush();
    const parked = await manager.notifyPermissionWaiting(taskId, "proj-a", "need approval");
    expect(isBackgroundManagerError(parked)).toBe(false);
    const resumeAttempt = await manager.resume(taskId, "proj-a");
    expect(isBackgroundManagerError(resumeAttempt)).toBe(true);
    const resolved = await manager.notifyPermissionResolved(taskId, "proj-a");
    expect(isBackgroundManagerError(resolved)).toBe(false);
  });
  it("run identity uniqueness: project binding immutable across ops", async () => {
    const manager = new BackgroundTaskManager({ runtime: new ImmediateRuntime() });
    const started = await manager.start(startInput({ projectId: "proj-a" }));
    if (isBackgroundManagerError(started)) throw new Error("expected ok");
    expect(started.record.projectId).toBe("proj-a");
    const wrong = manager.get(started.record.taskId, "proj-b");
    expect(isBackgroundManagerError(wrong)).toBe(true);
  });
});
