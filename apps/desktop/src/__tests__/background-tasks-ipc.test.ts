// PR43: apps/desktop — Background Tasks IPC Dispatch Tests
//
// Exactly 7 typed background-tasks:* channels validate input in main before
// any handler executes; malformed input fails without touching the service.
// Service failures serialize as safe envelopes (code prefix, no stacks).
// There is intentionally NO background-tasks:execute channel.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { createConversationId, createTaskId } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { DesktopBackgroundTaskService } from "../main/agent/background-task-service.js";

const BACKGROUND_CHANNELS = [
  IPC_CHANNELS.BACKGROUND_TASKS_LIST,
  IPC_CHANNELS.BACKGROUND_TASKS_GET,
  IPC_CHANNELS.BACKGROUND_TASKS_START,
  IPC_CHANNELS.BACKGROUND_TASKS_PAUSE,
  IPC_CHANNELS.BACKGROUND_TASKS_RESUME,
  IPC_CHANNELS.BACKGROUND_TASKS_CANCEL,
  IPC_CHANNELS.BACKGROUND_TASKS_RESPOND,
] as const;

function projection(taskId: string, projectId: string, status = "running") {
  const timestamp = new Date().toISOString();
  return {
    taskId,
    projectId,
    title: "Demo background work",
    status,
    mode: "background",
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 1,
    nodeCount: 0,
  };
}

function createStubService() {
  const calls: Record<string, unknown[]> = {
    list: [],
    get: [],
    start: [],
    pause: [],
    resume: [],
    cancel: [],
    respond: [],
  };
  const service = {
    list: async (projectId: string) => {
      calls.list.push(projectId);
      return [];
    },
    get: async (taskId: string, projectId: string) => {
      calls.get.push({ taskId, projectId });
      return projection(taskId, projectId);
    },
    start: async (input: { projectId: string; goal: string }) => {
      calls.start.push(input);
      return projection(createTaskId(), input.projectId, "queued");
    },
    pause: async (taskId: string, projectId: string) => {
      calls.pause.push({ taskId, projectId });
      return projection(taskId, projectId, "paused");
    },
    resume: async (taskId: string, projectId: string) => {
      calls.resume.push({ taskId, projectId });
      return projection(taskId, projectId, "running");
    },
    cancel: async (taskId: string, projectId: string, reason?: string) => {
      calls.cancel.push({ taskId, projectId, reason });
      return { task: projection(taskId, projectId, "cancelled"), cancelled: true };
    },
    respond: async (taskId: string, projectId: string, input: string) => {
      calls.respond.push({ taskId, projectId, input });
      return projection(taskId, projectId, "running");
    },
  };
  return { calls, service };
}

function createHarness() {
  const { calls, service } = createStubService();
  const ipcRegistry = new IpcRegistry();
  registerIpcHandlers(ipcRegistry, {
    backgroundTaskService: service as unknown as DesktopBackgroundTaskService,
  });
  return { ipcRegistry, calls };
}

describe("apps/desktop: Background Tasks IPC dispatch (PR43)", () => {
  it("registers exactly the 7 background-tasks:* channels and no execute channel", () => {
    const { ipcRegistry } = createHarness();
    expect(BACKGROUND_CHANNELS).toHaveLength(7);
    for (const channel of BACKGROUND_CHANNELS) {
      expect(ipcRegistry.registeredChannels.has(channel)).toBe(true);
    }
    for (const channel of ipcRegistry.registeredChannels) {
      expect(channel.toLowerCase().includes("execute")).toBe(false);
    }
  });

  it("background-tasks:list delegates with the caller projectId", async () => {
    const { ipcRegistry, calls } = createHarness();
    const res = await ipcRegistry.invokeCommand<{ tasks: unknown[] }>(
      IPC_CHANNELS.BACKGROUND_TASKS_LIST,
      { projectId: "proj-a" },
    );
    expect(res.ok).toBe(true);
    expect(calls.list).toEqual(["proj-a"]);
  });

  it("background-tasks:get delegates with taskId + projectId", async () => {
    const { ipcRegistry, calls } = createHarness();
    const taskId = createTaskId();
    const res = await ipcRegistry.invokeCommand<{ task: { taskId: string } }>(
      IPC_CHANNELS.BACKGROUND_TASKS_GET,
      { taskId, projectId: "proj-a" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.task.taskId).toBe(taskId);
    }
    expect(calls.get).toHaveLength(1);
  });

  it("background-tasks:start delegates goal/projectId and returns the projection", async () => {
    const { ipcRegistry, calls } = createHarness();
    const res = await ipcRegistry.invokeCommand<{ task: { status: string } }>(
      IPC_CHANNELS.BACKGROUND_TASKS_START,
      {
        projectId: "proj-a",
        goal: "Rebuild the project search index",
        conversationId: createConversationId(),
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.task.status).toBe("queued");
    }
    expect(calls.start).toHaveLength(1);
  });

  it("background-tasks:pause/resume/cancel/respond dispatch and report faithfully", async () => {
    const { ipcRegistry, calls } = createHarness();
    const taskId = createTaskId();

    const paused = await ipcRegistry.invokeCommand<{ task: { status: string } }>(
      IPC_CHANNELS.BACKGROUND_TASKS_PAUSE,
      { taskId, projectId: "proj-a" },
    );
    expect(paused.ok).toBe(true);
    if (paused.ok) expect(paused.value.task.status).toBe("paused");

    const resumed = await ipcRegistry.invokeCommand<{ task: { status: string } }>(
      IPC_CHANNELS.BACKGROUND_TASKS_RESUME,
      { taskId, projectId: "proj-a" },
    );
    expect(resumed.ok).toBe(true);

    const cancelled = await ipcRegistry.invokeCommand<{
      task: { status: string };
      cancelled: boolean;
    }>(IPC_CHANNELS.BACKGROUND_TASKS_CANCEL, {
      taskId,
      projectId: "proj-a",
      reason: "no longer needed",
    });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.cancelled).toBe(true);
      expect(cancelled.value.task.status).toBe("cancelled");
    }

    const answered = await ipcRegistry.invokeCommand<{ task: { status: string } }>(
      IPC_CHANNELS.BACKGROUND_TASKS_RESPOND,
      { taskId, projectId: "proj-a", input: "Use the primary host" },
    );
    expect(answered.ok).toBe(true);

    expect(calls.pause).toHaveLength(1);
    expect(calls.resume).toHaveLength(1);
    expect(calls.cancel).toHaveLength(1);
    expect(calls.respond).toHaveLength(1);
  });

  it("rejects malformed task ids before any handler executes", async () => {
    const { ipcRegistry, calls } = createHarness();
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.BACKGROUND_TASKS_GET, {
      taskId: "not-a-ulid",
      projectId: "proj-a",
    });
    expect(res.ok).toBe(false);
    expect(calls.get).toHaveLength(0);
  });

  it("rejects empty goals and oversized input before any handler executes", async () => {
    const { ipcRegistry, calls } = createHarness();
    const empty = await ipcRegistry.invokeCommand(IPC_CHANNELS.BACKGROUND_TASKS_START, {
      projectId: "proj-a",
      goal: "",
    });
    expect(empty.ok).toBe(false);
    const oversized = await ipcRegistry.invokeCommand(IPC_CHANNELS.BACKGROUND_TASKS_RESPOND, {
      taskId: createTaskId(),
      projectId: "proj-a",
      input: "x".repeat(2001),
    });
    expect(oversized.ok).toBe(false);
    expect(calls.start).toHaveLength(0);
    expect(calls.respond).toHaveLength(0);
  });

  it("serializes service failures safely (code prefix, no stack)", async () => {
    const ipcRegistry = new IpcRegistry();
    const failing = {
      list: async () => {
        throw new Error("project-mismatch: background task does not belong to this project");
      },
      get: async () => null,
      start: async () => null,
      pause: async () => null,
      resume: async () => null,
      cancel: async () => null,
      respond: async () => null,
    };
    registerIpcHandlers(ipcRegistry, {
      backgroundTaskService: failing as unknown as DesktopBackgroundTaskService,
    });
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.BACKGROUND_TASKS_LIST, {
      projectId: "proj-b",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("project-mismatch");
      expect(res.error.message.includes("at ") && res.error.message.includes(".ts")).toBe(false);
    }
  });
});
