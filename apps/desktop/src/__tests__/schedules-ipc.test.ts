// PR44: apps/desktop — Schedules IPC Dispatch Tests
//
// Exactly 9 typed schedules:* channels validate input in main before any
// handler executes; malformed input fails without touching the service.
// Service failures serialize as safe envelopes (code prefix, no stacks).
// There is intentionally NO schedules:execute channel.

import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "@ai-desktop/shared";
import { createTaskId } from "@ai-desktop/shared";
import { IpcRegistry, registerIpcHandlers } from "../main/ipc/index.js";
import type { DesktopSchedulerService } from "../main/agent/scheduler-service.js";

const SCHEDULE_CHANNELS = [
  IPC_CHANNELS.SCHEDULES_LIST,
  IPC_CHANNELS.SCHEDULES_GET,
  IPC_CHANNELS.SCHEDULES_CREATE,
  IPC_CHANNELS.SCHEDULES_DELETE,
  IPC_CHANNELS.SCHEDULES_DISABLE,
  IPC_CHANNELS.SCHEDULES_ENABLE,
  IPC_CHANNELS.SCHEDULES_RUN_NOW,
  IPC_CHANNELS.SCHEDULES_RUNS,
  IPC_CHANNELS.SCHEDULES_UPDATE,
] as const;

function projection(scheduleId: string, projectId: string, enabled = true) {
  const timestamp = new Date().toISOString();
  return {
    scheduleId,
    projectId,
    name: "Nightly summary",
    prompt: "Summarize what changed today.",
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    timezone: "UTC",
    enabled,
    missedPolicy: "skip",
    overlapPolicy: "skip",
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: timestamp,
    runCount: 0,
    missedCount: 0,
  };
}

function runProjection(runId: string, scheduleId: string, projectId: string) {
  const timestamp = new Date().toISOString();
  return {
    runId,
    scheduleId,
    projectId,
    trigger: "scheduled",
    status: "completed",
    scheduledFor: timestamp,
    createdAt: timestamp,
  };
}

function createStubService() {
  const calls: Record<string, unknown[]> = {
    list: [],
    get: [],
    create: [],
    update: [],
    enable: [],
    disable: [],
    delete: [],
    runNow: [],
    listRuns: [],
  };
  const service = {
    list: async (projectId: string) => {
      calls.list.push(projectId);
      return [];
    },
    get: async (scheduleId: string, projectId: string) => {
      calls.get.push({ scheduleId, projectId });
      return projection(scheduleId, projectId);
    },
    create: async (input: { projectId: string; name: string }) => {
      calls.create.push(input);
      return projection(createTaskId(), input.projectId);
    },
    update: async (scheduleId: string, projectId: string, patch: unknown) => {
      calls.update.push({ scheduleId, projectId, patch });
      return projection(scheduleId, projectId);
    },
    enable: async (scheduleId: string, projectId: string) => {
      calls.enable.push({ scheduleId, projectId });
      return projection(scheduleId, projectId, true);
    },
    disable: async (scheduleId: string, projectId: string) => {
      calls.disable.push({ scheduleId, projectId });
      return projection(scheduleId, projectId, false);
    },
    delete: async (scheduleId: string, projectId: string) => {
      calls.delete.push({ scheduleId, projectId });
      return { deleted: true, scheduleId };
    },
    runNow: async (scheduleId: string, projectId: string) => {
      calls.runNow.push({ scheduleId, projectId });
      return {
        schedule: projection(scheduleId, projectId),
        run: runProjection(createTaskId(), scheduleId, projectId),
      };
    },
    listRuns: async (scheduleId: string, projectId: string, limit?: number) => {
      calls.listRuns.push({ scheduleId, projectId, limit });
      return [];
    },
  };
  return { calls, service };
}

function createHarness() {
  const { calls, service } = createStubService();
  const ipcRegistry = new IpcRegistry();
  registerIpcHandlers(ipcRegistry, {
    schedulerService: service as unknown as DesktopSchedulerService,
  });
  return { ipcRegistry, calls };
}

function createInput() {
  return {
    projectId: "proj-a",
    name: "Nightly summary",
    prompt: "Summarize what changed today and report blockers.",
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    timezone: "UTC",
    missedPolicy: "skip",
    overlapPolicy: "queue_one",
    enabled: true,
  };
}

describe("apps/desktop: Schedules IPC dispatch (PR44)", () => {
  it("registers exactly the 9 schedules:* channels and no execute channel", () => {
    const { ipcRegistry } = createHarness();
    expect(SCHEDULE_CHANNELS).toHaveLength(9);
    for (const channel of SCHEDULE_CHANNELS) {
      expect(ipcRegistry.registeredChannels.has(channel)).toBe(true);
    }
    for (const channel of ipcRegistry.registeredChannels) {
      expect(channel.toLowerCase().includes("execute")).toBe(false);
    }
  });

  it("schedules:list delegates with the caller projectId", async () => {
    const { ipcRegistry, calls } = createHarness();
    const res = await ipcRegistry.invokeCommand<{ schedules: unknown[] }>(
      IPC_CHANNELS.SCHEDULES_LIST,
      { projectId: "proj-a" },
    );
    expect(res.ok).toBe(true);
    expect(calls.list).toEqual(["proj-a"]);
  });

  it("schedules:get delegates with scheduleId + projectId", async () => {
    const { ipcRegistry, calls } = createHarness();
    const scheduleId = createTaskId();
    const res = await ipcRegistry.invokeCommand<{ schedule: { scheduleId: string } }>(
      IPC_CHANNELS.SCHEDULES_GET,
      { scheduleId, projectId: "proj-a" },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.schedule.scheduleId).toBe(scheduleId);
    }
    expect(calls.get).toHaveLength(1);
  });

  it("schedules:create delegates the full payload and returns the projection", async () => {
    const { ipcRegistry, calls } = createHarness();
    const res = await ipcRegistry.invokeCommand<{ schedule: { projectId: string } }>(
      IPC_CHANNELS.SCHEDULES_CREATE,
      createInput(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.schedule.projectId).toBe("proj-a");
    }
    expect(calls.create).toHaveLength(1);
  });

  it("schedules:update/enable/disable/delete/run-now/runs dispatch and report faithfully", async () => {
    const { ipcRegistry, calls } = createHarness();
    const scheduleId = createTaskId();

    const updated = await ipcRegistry.invokeCommand<{ schedule: { scheduleId: string } }>(
      IPC_CHANNELS.SCHEDULES_UPDATE,
      { scheduleId, projectId: "proj-a", name: "Renamed" },
    );
    expect(updated.ok).toBe(true);

    const enabled = await ipcRegistry.invokeCommand<{ schedule: { enabled: boolean } }>(
      IPC_CHANNELS.SCHEDULES_ENABLE,
      { scheduleId, projectId: "proj-a" },
    );
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.value.schedule.enabled).toBe(true);

    const disabled = await ipcRegistry.invokeCommand<{ schedule: { enabled: boolean } }>(
      IPC_CHANNELS.SCHEDULES_DISABLE,
      { scheduleId, projectId: "proj-a" },
    );
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.value.schedule.enabled).toBe(false);

    const deleted = await ipcRegistry.invokeCommand<{
      deleted: boolean;
      scheduleId: string;
    }>(IPC_CHANNELS.SCHEDULES_DELETE, { scheduleId, projectId: "proj-a" });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value.deleted).toBe(true);
      expect(deleted.value.scheduleId).toBe(scheduleId);
    }

    const ran = await ipcRegistry.invokeCommand<{ schedule: unknown; run: { trigger: string } }>(
      IPC_CHANNELS.SCHEDULES_RUN_NOW,
      { scheduleId, projectId: "proj-a" },
    );
    expect(ran.ok).toBe(true);

    const runs = await ipcRegistry.invokeCommand<{ runs: unknown[] }>(IPC_CHANNELS.SCHEDULES_RUNS, {
      scheduleId,
      projectId: "proj-a",
      limit: 10,
    });
    expect(runs.ok).toBe(true);

    expect(calls.update).toHaveLength(1);
    expect(calls.enable).toHaveLength(1);
    expect(calls.disable).toHaveLength(1);
    expect(calls.delete).toHaveLength(1);
    expect(calls.runNow).toHaveLength(1);
    expect(calls.listRuns).toHaveLength(1);
  });

  it("rejects malformed schedule ids before any handler executes", async () => {
    const { ipcRegistry, calls } = createHarness();
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_GET, {
      scheduleId: "not-a-ulid",
      projectId: "proj-a",
    });
    expect(res.ok).toBe(false);
    expect(calls.get).toHaveLength(0);
  });

  it("rejects empty names, empty prompts, and unknown kinds before any handler executes", async () => {
    const { ipcRegistry, calls } = createHarness();
    const emptyName = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_CREATE, {
      ...createInput(),
      name: "",
    });
    expect(emptyName.ok).toBe(false);
    const emptyPrompt = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_CREATE, {
      ...createInput(),
      prompt: "",
    });
    expect(emptyPrompt.ok).toBe(false);
    const badKind = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_CREATE, {
      ...createInput(),
      schedule: { kind: "cron" },
    });
    expect(badKind.ok).toBe(false);
    const subMinute = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_CREATE, {
      ...createInput(),
      schedule: { kind: "interval", intervalMs: 5_000 },
    });
    expect(subMinute.ok).toBe(false);
    expect(calls.create).toHaveLength(0);
  });

  it("serializes service failures safely (code prefix, no stack)", async () => {
    const ipcRegistry = new IpcRegistry();
    const failing = {
      list: async () => {
        throw new Error("project-mismatch: schedule does not belong to this project");
      },
      get: async () => null,
      create: async () => null,
      update: async () => null,
      enable: async () => null,
      disable: async () => null,
      delete: async () => null,
      runNow: async () => null,
      listRuns: async () => null,
    };
    registerIpcHandlers(ipcRegistry, {
      schedulerService: failing as unknown as DesktopSchedulerService,
    });
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_LIST, {
      projectId: "proj-b",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("project-mismatch");
      expect(res.error.message.includes("at ") && res.error.message.includes(".ts")).toBe(false);
    }
  });

  it("registers fail-closed stubs when the service is absent", async () => {
    const ipcRegistry = new IpcRegistry();
    registerIpcHandlers(ipcRegistry, {});
    for (const channel of SCHEDULE_CHANNELS) {
      expect(ipcRegistry.registeredChannels.has(channel)).toBe(true);
    }
    const res = await ipcRegistry.invokeCommand(IPC_CHANNELS.SCHEDULES_LIST, {
      projectId: "proj-a",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("SchedulerService is not available");
    }
  });
});
