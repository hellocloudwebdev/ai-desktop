// PR43: renderer — Background Task Center tests (store/projection-level)
//
// Pure/store-level coverage for the Task Center renderer layer: grouping
// active vs completed, project-isolation display, permission/input states,
// disconnect-requery through the local stub, secret hygiene, and render
// truncation. Component-contract assertions follow the repo's established
// source-assertion pattern (pure, no Electron, no DOM).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_ACTIVE_STATUSES,
  BACKGROUND_COMPLETED_STATUSES,
  BACKGROUND_ACTIVITY_EVENT_NAMES,
  MAX_BACKGROUND_DISPLAY_ERROR,
  MAX_BACKGROUND_DISPLAY_RESULT,
  MAX_BACKGROUND_DISPLAY_TITLE,
  backgroundStatusBadgeClass,
  backgroundStatusLabel,
  cancelBackgroundTask,
  countActiveBackgroundTasks,
  createLocalBackgroundTaskStub,
  fetchBackgroundTask,
  fetchBackgroundTaskList,
  filterBackgroundTasksByProject,
  formatBackgroundDuration,
  getBackgroundTasksCommands,
  groupBackgroundTasks,
  isActiveBackgroundStatus,
  isCompletedBackgroundStatus,
  normalizeBackgroundTaskView,
  normalizeBackgroundTaskViews,
  pauseBackgroundTask,
  redactSecretAssignments,
  respondBackgroundTask,
  resumeBackgroundTask,
  truncateErrorText,
  truncateResultSummary,
  truncateText,
  truncateTitle,
  unwrapBackgroundTask,
  unwrapBackgroundTaskList,
  type BackgroundTaskView,
} from "../workspace/background-tasks.js";
import type { BackgroundTaskProjection } from "@ai-desktop/ai-core";

const CENTER = path.resolve(__dirname, "../components/workspace/surfaces/BackgroundTaskCenter.tsx");
const TASK_SURFACES = path.resolve(__dirname, "../components/workspace/surfaces/TaskSurfaces.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const SIDEBAR = path.resolve(__dirname, "../components/workspace/WorkspaceSidebar.tsx");
const BRIDGE = path.resolve(__dirname, "../workspace/background-tasks.ts");
const TYPES = path.resolve(__dirname, "../workspace/types.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function makeView(overrides: Partial<BackgroundTaskView> & { taskId: string }): BackgroundTaskView {
  return {
    projectId: "proj-A",
    title: "Summarize the quarterly report",
    status: "running",
    mode: "background",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:05:00.000Z",
    startedAt: "2026-09-18T10:01:00.000Z",
    attempt: 0,
    ...overrides,
  };
}

function makeProjection(
  overrides: { taskId: string } & Partial<Omit<BackgroundTaskProjection, "taskId">>,
): BackgroundTaskProjection {
  const { taskId, ...rest } = overrides;
  return {
    projectId: "proj-A",
    title: "Summarize the quarterly report",
    status: "queued",
    mode: "background",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    attempt: 0,
    ...rest,
    taskId: taskId as BackgroundTaskProjection["taskId"],
  };
}

describe("renderer: background status vocabulary (PR43)", () => {
  it("covers every ai-core background status exactly once", () => {
    const all = [...BACKGROUND_ACTIVE_STATUSES, ...BACKGROUND_COMPLETED_STATUSES];
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
    for (const status of [
      "queued",
      "running",
      "waiting_permission",
      "waiting_input",
      "paused",
      "cancelling",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(all).toContain(status);
    }
  });

  it("classifies active vs completed without overlap", () => {
    expect(isActiveBackgroundStatus("running")).toBe(true);
    expect(isActiveBackgroundStatus("waiting_permission")).toBe(true);
    expect(isActiveBackgroundStatus("waiting_input")).toBe(true);
    expect(isActiveBackgroundStatus("queued")).toBe(true);
    expect(isActiveBackgroundStatus("paused")).toBe(true);
    expect(isActiveBackgroundStatus("completed")).toBe(false);
    expect(isCompletedBackgroundStatus("completed")).toBe(true);
    expect(isCompletedBackgroundStatus("failed")).toBe(true);
    expect(isCompletedBackgroundStatus("cancelled")).toBe(true);
    expect(isCompletedBackgroundStatus("running")).toBe(false);
    expect(isActiveBackgroundStatus("bogus")).toBe(false);
  });

  it("labels waiting states for human review", () => {
    expect(backgroundStatusLabel("waiting_permission")).toBe("Waiting for approval");
    expect(backgroundStatusLabel("waiting_input")).toBe("Waiting for input");
    expect(backgroundStatusLabel("running")).toBe("Running");
    expect(backgroundStatusBadgeClass("waiting_permission")).toContain("orange");
    expect(backgroundStatusBadgeClass("failed")).toContain("rose");
  });

  it("names task.background.* transitions from the existing event vocabulary", () => {
    expect(BACKGROUND_ACTIVITY_EVENT_NAMES).toContain("task.background.started");
    expect(BACKGROUND_ACTIVITY_EVENT_NAMES).toContain("task.background.waiting_permission");
    expect(BACKGROUND_ACTIVITY_EVENT_NAMES).toContain("task.background.completed");
    expect(BACKGROUND_ACTIVITY_EVENT_NAMES).toContain("task.background.recovered");
    expect(BACKGROUND_ACTIVITY_EVENT_NAMES).toHaveLength(10);
  });
});

describe("renderer: background projection normalization (PR43)", () => {
  it("accepts IPC envelopes and raw payloads", () => {
    const view = makeView({ taskId: "01T1" });
    expect(
      normalizeBackgroundTaskViews(
        unwrapBackgroundTaskList({ ok: true, value: { tasks: [view] } }),
      ),
    ).toHaveLength(1);
    expect(
      normalizeBackgroundTaskViews(unwrapBackgroundTaskList({ ok: true, value: [view] })),
    ).toHaveLength(1);
    expect(normalizeBackgroundTaskViews(unwrapBackgroundTaskList([view]))).toHaveLength(1);
    expect(
      normalizeBackgroundTaskView(unwrapBackgroundTask({ ok: true, value: { task: view } })),
    ).toMatchObject({ taskId: "01T1" });
    expect(unwrapBackgroundTaskList({ ok: false })).toEqual([]);
    expect(unwrapBackgroundTaskList(null)).toEqual([]);
  });

  it("rejects foreground tasks, unknown statuses, and malformed entries", () => {
    const base = makeView({ taskId: "01T1" });
    expect(normalizeBackgroundTaskView({ ...base, mode: "foreground" })).toBeNull();
    expect(normalizeBackgroundTaskView({ ...base, status: "active" })).toBeNull();
    expect(normalizeBackgroundTaskView({ ...base, taskId: "" })).toBeNull();
    expect(normalizeBackgroundTaskView({ ...base, projectId: "" })).toBeNull();
    expect(normalizeBackgroundTaskView(null)).toBeNull();
    expect(normalizeBackgroundTaskView("task")).toBeNull();
  });

  it("defaults missing attempt and preserves the current node", () => {
    const { attempt: _dropped, ...withoutAttempt } = makeView({ taskId: "01T1" });
    void _dropped;
    expect(normalizeBackgroundTaskView(withoutAttempt)?.attempt).toBe(0);
    const withNode = makeView({
      taskId: "01T2",
      currentNode: { id: "01N1", goal: "Read the notes", status: "active" },
      nodeCount: 3,
    });
    expect(normalizeBackgroundTaskView(withNode)?.currentNode?.goal).toBe("Read the notes");
  });
});

describe("renderer: active vs completed grouping (PR43)", () => {
  it("splits sections and orders active by status priority", () => {
    const tasks = [
      makeView({ taskId: "01C1", status: "completed" }),
      makeView({ taskId: "01Q1", status: "queued" }),
      makeView({ taskId: "01R1", status: "running" }),
      makeView({ taskId: "01P1", status: "waiting_permission" }),
      makeView({ taskId: "01F1", status: "failed" }),
      makeView({ taskId: "01X1", status: "cancelled" }),
      makeView({ taskId: "01W1", status: "waiting_input" }),
      makeView({ taskId: "01Z1", status: "paused" }),
    ];
    const grouped = groupBackgroundTasks(tasks);
    expect(grouped.active.map((t) => t.status)).toEqual([
      "running",
      "waiting_permission",
      "waiting_input",
      "queued",
      "paused",
    ]);
    expect(grouped.completed.map((t) => t.status).sort()).toEqual(
      ["cancelled", "completed", "failed"].sort(),
    );
    expect(countActiveBackgroundTasks(tasks)).toBe(5);
  });
});

describe("renderer: project isolation display (PR43)", () => {
  it("filters by bound projectId without rewriting it", () => {
    const tasks = [
      makeView({ taskId: "01A1", projectId: "proj-A" }),
      makeView({ taskId: "01B1", projectId: "proj-B" }),
    ];
    const scoped = filterBackgroundTasksByProject(tasks, "proj-A");
    expect(scoped.map((t) => t.taskId)).toEqual(["01A1"]);
    // The bound id survives filtering untouched: switching projects never
    // re-scopes a task.
    expect(scoped[0]?.projectId).toBe("proj-A");
    expect(tasks[1]?.projectId).toBe("proj-B");
    expect(filterBackgroundTasksByProject(tasks, "proj-C")).toEqual([]);
  });
});

describe("renderer: disconnect-requery through the local stub (PR43)", () => {
  it("returns null bridge without window and empty lists without commands", async () => {
    expect(getBackgroundTasksCommands()).toBeNull();
    await expect(fetchBackgroundTaskList(null)).resolves.toEqual([]);
    await expect(fetchBackgroundTask(null, "01T1")).resolves.toBeNull();
    await expect(pauseBackgroundTask(null, "01T1")).resolves.toMatchObject({ ok: false });
    await expect(resumeBackgroundTask(null, "01T1")).resolves.toMatchObject({ ok: false });
    await expect(cancelBackgroundTask(null, "01T1")).resolves.toMatchObject({ ok: false });
    await expect(respondBackgroundTask(null, "01T1", "hi")).resolves.toMatchObject({ ok: false });
  });

  it("re-queries stub state after remount/disconnect (no renderer truth)", async () => {
    const stub = createLocalBackgroundTaskStub([
      makeProjection({ taskId: "01S1", status: "running", projectId: "proj-A" }),
    ]);
    // First "mount": list through the bridge shape.
    const first = await fetchBackgroundTaskList(stub, "proj-A");
    expect(first.map((t) => t.taskId)).toEqual(["01S1"]);
    // Mutations land bridge-side; a fresh "remount" re-reads them.
    await expect(pauseBackgroundTask(stub, "01S1")).resolves.toMatchObject({ ok: true });
    const second = await fetchBackgroundTaskList(stub);
    expect(second[0]?.status).toBe("paused");
    const detail = await fetchBackgroundTask(stub, "01S1");
    expect(detail?.projectId).toBe("proj-A");
    await expect(fetchBackgroundTask(stub, "01NOPE")).resolves.toBeNull();
  });

  it("enforces legal transitions in the stub (paused resumes via queued)", async () => {
    const stub = createLocalBackgroundTaskStub([
      makeProjection({ taskId: "01S2", status: "paused", projectId: "proj-A" }),
    ]);
    await expect(resumeBackgroundTask(stub, "01S2")).resolves.toMatchObject({ ok: true });
    expect((await fetchBackgroundTask(stub, "01S2"))?.status).toBe("queued");
    await expect(pauseBackgroundTask(stub, "01S2")).resolves.toMatchObject({ ok: false });
  });

  it("answers waiting_input via respond, never via permission paths", async () => {
    const stub = createLocalBackgroundTaskStub([
      makeProjection({ taskId: "01S3", status: "waiting_input", projectId: "proj-A" }),
    ]);
    await expect(respondBackgroundTask(stub, "01S3", "  ")).resolves.toMatchObject({ ok: false });
    await expect(respondBackgroundTask(stub, "01S3", "use Postgres")).resolves.toMatchObject({
      ok: true,
    });
    expect((await fetchBackgroundTask(stub, "01S3"))?.status).toBe("running");
    // Responding outside waiting_input is an invalid transition.
    await expect(respondBackgroundTask(stub, "01S3", "again")).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("renderer: hygiene — truncation and secret redaction (PR43)", () => {
  it("bounds titles, errors, and results at render", () => {
    expect(MAX_BACKGROUND_DISPLAY_TITLE).toBe(120);
    expect(MAX_BACKGROUND_DISPLAY_ERROR).toBe(2000);
    expect(MAX_BACKGROUND_DISPLAY_RESULT).toBe(8000);
    expect(truncateTitle("x".repeat(200))).toHaveLength(121);
    expect(truncateErrorText("x".repeat(2500))).toHaveLength(2001);
    expect(truncateResultSummary("x".repeat(9000))).toHaveLength(8001);
    expect(truncateText("short", 120)).toBe("short");
  });

  it("redacts assignment-shaped secrets but keeps plain prose", () => {
    expect(redactSecretAssignments("api_key=sk-live-12345")).toBe("api_key: [redacted]");
    expect(redactSecretAssignments("Authorization: Bearer abc.def")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactSecretAssignments("password: hunter2 failed")).toBe("password: [redacted] failed");
    // Prose that merely mentions the words is not secret material.
    expect(redactSecretAssignments("token limit exceeded, retry later")).toBe(
      "token limit exceeded, retry later",
    );
  });

  it("formats duration safely without throwing", () => {
    const task = makeView({
      taskId: "01D1",
      startedAt: "2026-09-18T10:00:00.000Z",
      completedAt: "2026-09-18T10:03:12.000Z",
    });
    expect(formatBackgroundDuration(task)).toBe("3m 12s");
    expect(formatBackgroundDuration(makeView({ taskId: "01D2", startedAt: undefined }))).toBe("—");
  });
});

describe("Background Task Center contract (PR43)", () => {
  it("extends props with the background center contract", () => {
    const props = read(PROPS);
    expect(props).toContain("BackgroundTaskCenterProps");
    expect(props).toContain("pendingPermissions?");
    expect(props).toContain("onResolvePermission?");
    expect(props).toContain("taskActivity?");
    expect(props).toContain("background?: BackgroundTaskCenterProps");
    expect(props).toContain("backgroundActiveCount?");
  });

  it("renders Active/Completed sections with the required row fields", () => {
    const component = read(CENTER);
    expect(component).toContain("Background tasks");
    // Status labels render through backgroundStatusLabel(); the approval
    // and input banners below are literal (review affordances).
    expect(component).toContain("backgroundStatusLabel");
    expect(component).toContain("Background task requires approval");
    expect(component).toContain("Background task is waiting for input");
    expect(component).toContain("Completed");
    expect(component).toContain("project:");
    expect(component).toContain("duration");
    expect(component).toContain("currentNode");
    expect(component).toContain("resultSummary");
    expect(component).toContain("lastError");
  });

  it("routes approval through the existing permission path and never auto-approves", () => {
    const component = read(CENTER);
    expect(component).toContain("Background task requires approval");
    expect(component).toContain("onResolvePermission");
    expect(component).toContain("never");
    expect(component).toContain("auto-approv");
    expect(component).not.toMatch(/autoApprov\s*=\s*true/);
    expect(component).not.toMatch(/approveAutomatically/);
  });

  it("answers waiting_input through respond with an input box", () => {
    const component = read(CENTER);
    expect(component).toContain("waiting for input");
    expect(component).toContain("background-input-response");
    expect(component).toContain("respondBackgroundTask");
    expect(component).toContain("Pause");
    expect(component).toContain("Resume (re-queue)");
    expect(component).toContain("Cancel");
  });

  it("re-queries on mount and polls without renderer-local truth", () => {
    const component = read(CENTER);
    expect(component).toContain("getBackgroundTasksCommands");
    expect(component).toContain("createLocalBackgroundTaskStub");
    expect(component).toContain("setInterval");
    expect(component).toContain("clearInterval");
    expect(component).toContain("re-queries");
  });

  it("derives the timeline from existing activity projections only", () => {
    const component = read(CENTER);
    expect(component).toContain("taskActivity");
    expect(component).toContain('kind === "task"');
    expect(component).not.toMatch(/notificationBus|NotificationBus|subscribeToBackground/);
  });

  it("keeps the surface free of privileged imports and raw HTML", () => {
    for (const file of [CENTER, BRIDGE, TASK_SURFACES]) {
      const source = read(file);
      expect(source.includes("dangerouslySetInnerHTML")).toBe(false);
      expect(source).not.toMatch(/from\s+["']electron["']/);
      expect(source).not.toMatch(/from\s+["']node:/);
      expect(source).not.toMatch(/child_process/);
      expect(source).not.toMatch(/@prisma\/client/);
    }
    expect(read(CENTER)).not.toMatch(/window\.api\.backgroundTasks\.[a-z]+\(/);
  });

  it("exposes the narrow background bridge with the expected methods", () => {
    const bridge = read(BRIDGE);
    for (const method of ["list", "get", "start", "pause", "resume", "cancel", "respond"]) {
      expect(bridge).toContain(method);
    }
    expect(bridge).toContain("window.api");
    expect(bridge).toContain("backgroundTasks");
    expect(bridge).toContain("?.");
  });

  it("extends the Tasks surface into a Task Center without replacing it", () => {
    const tasks = read(TASK_SURFACES);
    expect(tasks).toContain("BackgroundTaskCenter");
    expect(tasks).toContain("agentTasks");
    expect(tasks).toContain("TaskNodeChecklist");
  });

  it("shows background counts on the Tasks sidebar entry", () => {
    const sidebar = read(SIDEBAR);
    expect(sidebar).toContain("backgroundActiveCount");
    expect(sidebar).toContain("tasksTotal");
  });

  it("registers the Task Center on the existing tasks surface", () => {
    const types = read(TYPES);
    expect(types).toContain("TASK_CENTER_SURFACE");
    expect(types).not.toContain('"task-center"');
  });
});
