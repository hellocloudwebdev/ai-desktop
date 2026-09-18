// PR44: packages/agent-runtime — BackgroundScheduler tests
//
// Thin orchestration: due launch via stub launcher, skip/queue_one overlap,
// missed skip vs run_once, catch-up cap, manual triggers, idempotent
// recovery, project binding, secret refusal, double-tick safety, pointer
// repair, enable/disable semantics, settle flow, and run pruning.

import { describe, expect, it } from "vitest";
import {
  createScheduledRunId,
  createScheduleId,
  type AIEvent,
  type ScheduledRunRecord,
  type ScheduledTaskRecord,
} from "@ai-desktop/ai-core";
import { createTaskId, type TaskId } from "@ai-desktop/shared";
import {
  BackgroundScheduler,
  InMemoryScheduleStore,
  isSchedulerError,
  type BackgroundTaskLauncher,
  type LaunchOutcome,
} from "../runtime/scheduling/background-scheduler.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-18T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

class StubLauncher implements BackgroundTaskLauncher {
  readonly calls: Array<{ projectId: string; goal: string; title?: string }> = [];
  behavior: (input: { projectId: string; goal: string; title?: string }) => LaunchOutcome = () => ({
    backgroundTaskId: createTaskId() as TaskId,
  });

  async launch(input: { projectId: string; goal: string; title?: string }): Promise<LaunchOutcome> {
    this.calls.push({ ...input });
    return this.behavior(input);
  }
}

class RecordingSink {
  readonly events: AIEvent[] = [];
  async publish(event: Readonly<AIEvent>): Promise<void> {
    this.events.push(event as AIEvent);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
  count(type: string): number {
    return this.events.filter((e) => e.type === type).length;
  }
}

function makeSchedule(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: createScheduleId(),
    projectId: "proj-1",
    name: "Hourly sync",
    prompt: "Sync the project board",
    kind: "interval",
    config: { everyMs: HOUR },
    timezone: "UTC",
    enabled: true,
    missedPolicy: "skip",
    overlapPolicy: "skip",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    nextRunAt: iso(T0 + HOUR),
    runCount: 0,
    missedCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

function setup(overrides: Partial<ScheduledTaskRecord> = {}) {
  const store = new InMemoryScheduleStore();
  const launcher = new StubLauncher();
  const sink = new RecordingSink();
  const scheduler = new BackgroundScheduler({
    store,
    launcher,
    eventSink: sink,
    clock: () => T0,
  });
  const schedule = makeSchedule(overrides);
  store.addSchedule(schedule);
  return { store, launcher, sink, scheduler, schedule };
}

function runsFor(store: InMemoryScheduleStore, scheduleId: string): ScheduledRunRecord[] {
  return store.listRuns(scheduleId as string);
}

describe("background-scheduler: due launch", () => {
  it("launches exactly one run when due, via the injected launcher", async () => {
    const { store, launcher, sink, scheduler, schedule } = setup();
    const summary = await scheduler.tick(T0 + HOUR + 1_000);
    expect(summary).toEqual({ launched: 1, skipped: 0, queued: 0, failed: 0 });
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]).toMatchObject({
      projectId: "proj-1",
      goal: "Sync the project board",
      title: "Hourly sync",
    });
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].scheduledFor).toBe(iso(T0 + HOUR));
    expect(runs[0].backgroundTaskId).toBeDefined();
    const updated = store.getSchedule(schedule.id as string);
    expect(updated?.runCount).toBe(1);
    expect(updated?.lastRunStatus).toBe("running");
    expect(updated?.lastRunAt).toBe(iso(T0 + HOUR));
    expect(updated?.nextRunAt).toBe(iso(T0 + 2 * HOUR));
    expect(sink.types()).toContain("schedule.due");
    expect(sink.types()).toContain("schedule.run.started");
  });

  it("does nothing before the fire time (and repairs no pointer when exact)", async () => {
    const { launcher, scheduler } = setup();
    const summary = await scheduler.tick(T0 + HOUR - 1_000);
    expect(summary).toEqual({ launched: 0, skipped: 0, queued: 0, failed: 0 });
    expect(launcher.calls).toHaveLength(0);
  });

  it("creates no duplicate run on an immediate double tick", async () => {
    const { store, launcher, scheduler, schedule } = setup();
    await scheduler.tick(T0 + HOUR + 1_000);
    const second = await scheduler.tick(T0 + HOUR + 1_000);
    expect(second).toEqual({ launched: 0, skipped: 0, queued: 0, failed: 0 });
    expect(launcher.calls).toHaveLength(1);
    expect(runsFor(store, schedule.id as string)).toHaveLength(1);
  });
});

describe("background-scheduler: overlap policies", () => {
  it("skips a new occurrence while a run is active (default skip)", async () => {
    const { store, launcher, sink, scheduler, schedule } = setup();
    await scheduler.tick(T0 + HOUR + 1_000);
    const summary = await scheduler.tick(T0 + 2 * HOUR + 1_000);
    expect(summary).toEqual({ launched: 0, skipped: 1, queued: 0, failed: 0 });
    expect(launcher.calls).toHaveLength(1);
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.status === "skipped")).toBeDefined();
    expect(sink.types()).toContain("schedule.run.skipped");
    const updated = store.getSchedule(schedule.id as string);
    expect(updated?.nextRunAt).toBe(iso(T0 + 3 * HOUR));
    expect(updated?.lastRunStatus).toBe("skipped");
  });

  it("parks exactly one queued occurrence under queue_one, then collapses", async () => {
    const { store, launcher, scheduler, schedule } = setup({ overlapPolicy: "queue_one" });
    await scheduler.tick(T0 + HOUR + 1_000);
    const parked = await scheduler.tick(T0 + 2 * HOUR + 1_000);
    expect(parked).toEqual({ launched: 0, skipped: 0, queued: 1, failed: 0 });
    expect(launcher.calls).toHaveLength(1);
    const parkedId = store.parkedFor(schedule.id as string);
    expect(parkedId).toBeDefined();
    const parkedRun = runsFor(store, schedule.id as string).find(
      (r) => (r.runId as string) === parkedId,
    );
    expect(parkedRun?.status).toBe("pending");
    // A further due occurrence while one is parked collapses into missedCount.
    const collapsed = await scheduler.tick(T0 + 3 * HOUR + 1_000);
    expect(collapsed.skipped).toBe(1);
    expect(collapsed.queued).toBe(0);
    expect(runsFor(store, schedule.id as string)).toHaveLength(2);
    expect(store.getSchedule(schedule.id as string)?.missedCount).toBe(1);
    // Settling the active run launches the parked occurrence (same record).
    const activeId = store.activeFor(schedule.id as string);
    const settled = await scheduler.settleRun(schedule.id, activeId, "completed");
    expect(isSchedulerError(settled)).toBe(false);
    expect(launcher.calls).toHaveLength(2);
    expect(store.activeFor(schedule.id as string)).toBe(parkedId);
    expect(store.parkedFor(schedule.id as string)).toBeUndefined();
  });

  it("adopts a durably-recorded pending run after a crash (no duplicate)", async () => {
    const store = new InMemoryScheduleStore();
    const launcher = new StubLauncher();
    const scheduler = new BackgroundScheduler({ store, launcher, clock: () => T0 });
    const schedule = makeSchedule();
    store.addSchedule(schedule);
    // Crash between record creation and launch: pending run, active slot set.
    const orphan: ScheduledRunRecord = {
      runId: createScheduledRunId(),
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      trigger: "scheduled",
      status: "pending",
      scheduledFor: iso(T0 + HOUR),
    };
    store.addRun(orphan);
    store.setActiveRunId(schedule.id as string, orphan.runId as string);
    const summary = await scheduler.tick(T0 + HOUR + 1_000);
    expect(summary.launched).toBe(1);
    expect(launcher.calls).toHaveLength(1);
    expect(runsFor(store, schedule.id as string)).toHaveLength(1);
    const adopted = runsFor(store, schedule.id as string)[0];
    expect(adopted.runId as string).toBe(orphan.runId as string);
    expect(adopted.status).toBe("running");
  });
});

describe("background-scheduler: missed policy + catch-up cap", () => {
  it("skip fires the current (latest) occurrence; excess collapses to missed", async () => {
    const { store, launcher, scheduler, schedule } = setup({ missedPolicy: "skip" });
    const summary = await scheduler.tick(T0 + 3 * HOUR + 10 * 60_000);
    expect(summary.launched).toBe(1);
    expect(launcher.calls).toHaveLength(1); // MAX_CATCH_UP_RUNS = 1
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduledFor).toBe(iso(T0 + 3 * HOUR));
    const updated = store.getSchedule(schedule.id as string);
    expect(updated?.missedCount).toBe(2);
    expect(updated?.runCount).toBe(1);
  });

  it("run_once fires the earliest due occurrence; excess collapses to missed", async () => {
    const { store, scheduler, schedule } = setup({ missedPolicy: "run_once" });
    const summary = await scheduler.tick(T0 + 3 * HOUR + 10 * 60_000);
    expect(summary.launched).toBe(1);
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduledFor).toBe(iso(T0 + HOUR));
    expect(store.getSchedule(schedule.id as string)?.missedCount).toBe(2);
  });

  it("fires one-shot once/delay schedules, then auto-disables", async () => {
    const onceSetup = setup({
      kind: "once",
      config: { runAt: iso(T0 + HOUR) },
      missedPolicy: "run_once",
      nextRunAt: iso(T0 + HOUR),
    });
    expect(await onceSetup.scheduler.tick(T0)).toEqual({
      launched: 0,
      skipped: 0,
      queued: 0,
      failed: 0,
    });
    const fired = await onceSetup.scheduler.tick(T0 + HOUR + 1_000);
    expect(fired.launched).toBe(1);
    expect(onceSetup.store.getSchedule(onceSetup.schedule.id as string)?.enabled).toBe(false);
    expect(onceSetup.sink.types()).toContain("schedule.disabled");
    // No second firing after auto-disable.
    expect(await onceSetup.scheduler.tick(T0 + 2 * HOUR)).toEqual({
      launched: 0,
      skipped: 0,
      queued: 0,
      failed: 0,
    });
    expect(onceSetup.launcher.calls).toHaveLength(1);

    const delaySetup = setup({
      kind: "delay",
      config: { delayMs: HOUR },
      missedPolicy: "run_once",
      nextRunAt: iso(T0 + HOUR),
    });
    expect(await delaySetup.scheduler.tick(T0 + 30 * 60_000)).toEqual({
      launched: 0,
      skipped: 0,
      queued: 0,
      failed: 0,
    });
    expect(await delaySetup.scheduler.tick(T0 + HOUR + 1_000)).toEqual({
      launched: 1,
      skipped: 0,
      queued: 0,
      failed: 0,
    });
    expect(delaySetup.store.getSchedule(delaySetup.schedule.id as string)?.enabled).toBe(false);
  });

  it("drops a past-due one-shot under missedPolicy skip (skipped + disabled)", async () => {
    const { store, sink, scheduler, schedule } = setup({
      kind: "once",
      config: { runAt: iso(T0 + HOUR) },
      missedPolicy: "skip",
      nextRunAt: iso(T0 + HOUR),
    });
    const summary = await scheduler.tick(T0 + 2 * HOUR);
    expect(summary).toEqual({ launched: 0, skipped: 1, queued: 0, failed: 0 });
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    const updated = store.getSchedule(schedule.id as string);
    expect(updated?.enabled).toBe(false);
    expect(updated?.missedCount).toBe(1);
    expect(sink.types()).toContain("schedule.run.skipped");
  });
});

describe("background-scheduler: launch failure (no scheduler retry)", () => {
  it("marks the run failed, releases the slot, and never hot-loops", async () => {
    const { store, launcher, sink, scheduler, schedule } = setup();
    launcher.behavior = () => ({ error: { code: "concurrency-limited", message: "pool busy" } });
    const summary = await scheduler.tick(T0 + HOUR + 1_000);
    expect(summary).toEqual({ launched: 0, skipped: 0, queued: 0, failed: 1 });
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toContain("concurrency-limited");
    expect(store.activeFor(schedule.id as string)).toBeUndefined();
    expect(store.getSchedule(schedule.id as string)?.lastRunStatus).toBe("failed");
    expect(sink.types()).toContain("schedule.run.failed");
    // The consumed occurrence does not refire: still exactly one launcher call.
    expect(await scheduler.tick(T0 + HOUR + 2_000)).toEqual({
      launched: 0,
      skipped: 0,
      queued: 0,
      failed: 0,
    });
    expect(launcher.calls).toHaveLength(1);
  });

  it("survives a throwing launcher as a launch failure", async () => {
    const { launcher, scheduler } = setup();
    launcher.behavior = () => {
      throw new Error("launcher exploded");
    };
    const summary = await scheduler.tick(T0 + HOUR + 1_000);
    expect(summary.failed).toBe(1);
  });
});

describe("background-scheduler: runNow (manual trigger)", () => {
  it("launches immediately without moving the periodic pointer", async () => {
    const { store, launcher, sink, scheduler, schedule } = setup();
    const result = await scheduler.runNow(schedule.id, "proj-1");
    expect(isSchedulerError(result)).toBe(false);
    if (isSchedulerError(result)) return;
    expect(result.run.trigger).toBe("manual");
    expect(result.run.status).toBe("running");
    expect(launcher.calls).toHaveLength(1);
    const updated = store.getSchedule(schedule.id as string);
    expect(updated?.runCount).toBe(1);
    expect(updated?.nextRunAt).toBe(iso(T0 + HOUR));
    expect(updated?.lastRunAt).toBeUndefined();
    expect(sink.types()).toContain("schedule.run.started");
  });

  it("allows manual runs on disabled schedules (explicit user action)", async () => {
    const { launcher, scheduler, schedule } = setup({ enabled: false });
    const result = await scheduler.runNow(schedule.id, "proj-1");
    expect(isSchedulerError(result)).toBe(false);
    expect(launcher.calls).toHaveLength(1);
  });

  it("refuses a second manual run while active under skip (task-active)", async () => {
    const { scheduler, schedule } = setup();
    await scheduler.runNow(schedule.id, "proj-1");
    const second = await scheduler.runNow(schedule.id, "proj-1");
    expect(isSchedulerError(second)).toBe(true);
    if (!isSchedulerError(second)) return;
    expect(second.error.code).toBe("task-active");
  });

  it("parks a manual run under queue_one without relaunching", async () => {
    const { store, launcher, scheduler, schedule } = setup({ overlapPolicy: "queue_one" });
    await scheduler.runNow(schedule.id, "proj-1");
    const parked = await scheduler.runNow(schedule.id, "proj-1");
    expect(isSchedulerError(parked)).toBe(false);
    if (isSchedulerError(parked)) return;
    expect(parked.run.status).toBe("pending");
    expect(launcher.calls).toHaveLength(1);
    expect(store.parkedFor(schedule.id as string)).toBe(parked.run.runId as string);
  });

  it("rejects malformed ids, unknown ids, and project mismatch", async () => {
    const { scheduler, schedule } = setup();
    const malformed = await scheduler.runNow("not-a-ulid", "proj-1");
    expect(isSchedulerError(malformed) && malformed.error.code).toBe("validation-error");
    const unknown = await scheduler.runNow(createScheduleId(), "proj-1");
    expect(isSchedulerError(unknown) && unknown.error.code).toBe("not-found");
    const mismatch = await scheduler.runNow(schedule.id, "proj-2");
    expect(isSchedulerError(mismatch) && mismatch.error.code).toBe("project-mismatch");
  });

  it("refuses secret-bearing schedules without launching", async () => {
    const { launcher, scheduler, schedule } = setup({
      prompt: "Summarize with api_key=sk-live-123",
    });
    const result = await scheduler.runNow(schedule.id, "proj-1");
    expect(isSchedulerError(result) && result.error.code).toBe("secret-refused");
    expect(launcher.calls).toHaveLength(0);
  });
});

describe("background-scheduler: settleRun", () => {
  it("records completion, clears the slot, and emits run.completed", async () => {
    const { store, sink, scheduler, schedule } = setup();
    await scheduler.tick(T0 + HOUR + 1_000);
    const activeId = store.activeFor(schedule.id as string);
    expect(activeId).toBeDefined();
    const settled = await scheduler.settleRun(schedule.id, activeId, "completed");
    expect(isSchedulerError(settled)).toBe(false);
    if (isSchedulerError(settled)) return;
    expect(settled.run.status).toBe("completed");
    expect(store.activeFor(schedule.id as string)).toBeUndefined();
    expect(sink.types()).toContain("schedule.run.completed");
    // Idempotent second settle: same record, no extra event.
    const eventsBefore = sink.events.length;
    const again = await scheduler.settleRun(schedule.id, activeId, "completed");
    expect(isSchedulerError(again)).toBe(false);
    expect(sink.events.length).toBe(eventsBefore);
  });

  it("records failure detail (bounded) and emits run.failed", async () => {
    const { store, scheduler, schedule } = setup();
    await scheduler.runNow(schedule.id, "proj-1");
    const activeId = store.activeFor(schedule.id as string);
    const settled = await scheduler.settleRun(schedule.id, activeId, "failed", {
      detail: "agent blew up",
    });
    expect(isSchedulerError(settled)).toBe(false);
    if (isSchedulerError(settled)) return;
    expect(settled.run.error).toBe("agent blew up");
  });

  it("settles cancelled runs silently (no schedule.run.cancelled type exists)", async () => {
    const { store, sink, scheduler, schedule } = setup();
    await scheduler.runNow(schedule.id, "proj-1");
    const activeId = store.activeFor(schedule.id as string);
    const before = sink.events.length;
    const settled = await scheduler.settleRun(schedule.id, activeId, "cancelled", {
      detail: "user cancelled",
    });
    expect(isSchedulerError(settled)).toBe(false);
    if (isSchedulerError(settled)) return;
    expect(settled.run.status).toBe("cancelled");
    expect(store.activeFor(schedule.id as string)).toBeUndefined();
    expect(sink.events.length).toBe(before);
  });

  it("rejects bad outcomes, unknown runs, and project mismatch", async () => {
    const { scheduler, schedule } = setup();
    const bad = await scheduler.settleRun(schedule.id, createScheduledRunId(), "nope" as never);
    expect(isSchedulerError(bad) && bad.error.code).toBe("validation-error");
    const unknown = await scheduler.settleRun(schedule.id, createScheduledRunId(), "completed");
    expect(isSchedulerError(unknown) && unknown.error.code).toBe("not-found");
    const second = setup();
    await second.scheduler.runNow(second.schedule.id, "proj-1");
    const activeId = second.store.activeFor(second.schedule.id as string);
    const mismatch = await second.scheduler.settleRun(second.schedule.id, activeId, "completed", {
      projectId: "proj-2",
    });
    expect(isSchedulerError(mismatch) && mismatch.error.code).toBe("project-mismatch");
  });
});

describe("background-scheduler: setEnabled", () => {
  it("disables future runs without killing the active run", async () => {
    const { store, launcher, sink, scheduler, schedule } = setup();
    await scheduler.tick(T0 + HOUR + 1_000);
    const activeId = store.activeFor(schedule.id as string);
    const disabled = await scheduler.setEnabled(schedule.id, "proj-1", false);
    expect(isSchedulerError(disabled)).toBe(false);
    expect(sink.types()).toContain("schedule.disabled");
    // Active run untouched.
    expect(store.activeFor(schedule.id as string)).toBe(activeId);
    // Future ticks launch nothing while disabled.
    expect(await scheduler.tick(T0 + 2 * HOUR + 1_000)).toEqual({
      launched: 0,
      skipped: 0,
      queued: 0,
      failed: 0,
    });
    expect(launcher.calls).toHaveLength(1);
    // Re-enable resumes ticking.
    await scheduler.setEnabled(schedule.id, "proj-1", true);
    expect(sink.types()).toContain("schedule.enabled");
    const resumed = await scheduler.tick(T0 + 2 * HOUR + 1_000);
    expect(resumed.skipped).toBe(1); // still active -> overlap skip
  });

  it("is idempotent for no-op flips and validates inputs", async () => {
    const { sink, scheduler, schedule } = setup();
    const eventsBefore = sink.events.length;
    const same = await scheduler.setEnabled(schedule.id, "proj-1", true);
    expect(isSchedulerError(same)).toBe(false);
    expect(sink.events.length).toBe(eventsBefore);
    const malformed = await scheduler.setEnabled("bad", "proj-1", false);
    expect(isSchedulerError(malformed) && malformed.error.code).toBe("validation-error");
    const unknown = await scheduler.setEnabled(createScheduleId(), "proj-1", false);
    expect(isSchedulerError(unknown) && unknown.error.code).toBe("not-found");
    const mismatch = await scheduler.setEnabled(schedule.id, "proj-2", false);
    expect(isSchedulerError(mismatch) && mismatch.error.code).toBe("project-mismatch");
  });
});

describe("background-scheduler: recover (idempotent startup)", () => {
  it("re-points a stale pointer per missedPolicy without touching missedCount", async () => {
    const store = new InMemoryScheduleStore();
    const launcher = new StubLauncher();
    const scheduler = new BackgroundScheduler({ store, launcher, clock: () => T0 });
    const schedule = makeSchedule({
      lastRunAt: iso(T0),
      nextRunAt: iso(T0), // stale: in the past
    });
    const first = await scheduler.recover([schedule], [], T0 + 3 * HOUR + 10 * 60_000);
    expect(first).toEqual({ validated: 1, rejected: 0, recomputed: 1, recoveredRuns: 0 });
    const stored = store.getSchedule(schedule.id as string);
    expect(stored?.nextRunAt).toBe(iso(T0 + 3 * HOUR)); // skip keeps latest
    expect(stored?.missedCount).toBe(0); // accounting stays in tick()
    // Second recovery is a no-op (version check + runId ledger).
    const savesBefore = store.scheduleSaves;
    const second = await scheduler.recover([schedule], [], T0 + 3 * HOUR + 10 * 60_000);
    expect(second).toEqual({ validated: 1, rejected: 0, recomputed: 0, recoveredRuns: 0 });
    expect(store.scheduleSaves).toBe(savesBefore);
    // The following tick performs the single missed accounting exactly once.
    const ticked = await scheduler.tick(T0 + 3 * HOUR + 10 * 60_000);
    expect(ticked.launched).toBe(1);
    expect(store.getSchedule(schedule.id as string)?.missedCount).toBe(2);
  });

  it("re-points run_once at the earliest due occurrence", async () => {
    const store = new InMemoryScheduleStore();
    const scheduler = new BackgroundScheduler({ store, launcher: new StubLauncher() });
    const schedule = makeSchedule({
      missedPolicy: "run_once",
      lastRunAt: iso(T0),
      nextRunAt: iso(T0),
    });
    await scheduler.recover([schedule], [], T0 + 3 * HOUR + 10 * 60_000);
    expect(store.getSchedule(schedule.id as string)?.nextRunAt).toBe(iso(T0 + HOUR));
  });

  it("snaps a drifted future pointer back to recomputation", async () => {
    const store = new InMemoryScheduleStore();
    const scheduler = new BackgroundScheduler({ store, launcher: new StubLauncher() });
    const schedule = makeSchedule({ nextRunAt: iso(T0 + 99 * HOUR) });
    const summary = await scheduler.recover([schedule], [], T0 + 30 * 60_000);
    expect(summary.recomputed).toBe(1);
    expect(store.getSchedule(schedule.id as string)?.nextRunAt).toBe(iso(T0 + HOUR));
  });

  it("rejects invalid, secret-bearing, and duplicated schedules", async () => {
    const scheduler = new BackgroundScheduler({
      store: new InMemoryScheduleStore(),
      launcher: new StubLauncher(),
    });
    const good = makeSchedule();
    const summary = await scheduler.recover(
      [
        good,
        { ...good }, // in-batch duplicate id
        { not: "a schedule" },
        { ...makeSchedule(), prompt: "leak password=hunter2-secret" },
      ],
      [],
      T0,
    );
    expect(summary.validated).toBe(1);
    expect(summary.rejected).toBe(3);
  });

  it("rebuilds the run ledger + active map, then launches nothing", async () => {
    const store = new InMemoryScheduleStore();
    const launcher = new StubLauncher();
    const sink = new RecordingSink();
    const scheduler = new BackgroundScheduler({ store, launcher, eventSink: sink });
    const schedule = makeSchedule();
    const running: ScheduledRunRecord = {
      runId: createScheduledRunId(),
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      backgroundTaskId: createTaskId(),
      trigger: "scheduled",
      status: "running",
      scheduledFor: iso(T0 + HOUR),
      startedAt: iso(T0 + HOUR + 1),
    };
    const first = await scheduler.recover([schedule], [running], T0 + HOUR + 1_000);
    expect(first).toEqual({ validated: 1, rejected: 0, recomputed: 0, recoveredRuns: 1 });
    expect(store.activeFor(schedule.id as string)).toBe(running.runId as string);
    expect(sink.types()).toContain("schedule.run.recovered");
    expect(launcher.calls).toHaveLength(0);
    // Idempotent replay: same summary shape, no extra writes, no duplicates.
    const runSaves = store.runSaves;
    const second = await scheduler.recover([schedule], [running], T0 + HOUR + 1_000);
    expect(second.recoveredRuns).toBe(1);
    expect(store.runSaves).toBe(runSaves);
    expect(store.listRuns(schedule.id as string)).toHaveLength(1);
    // Post-restart tick honours overlap instead of duplicating the launch.
    const ticked = await scheduler.tick(T0 + 2 * HOUR + 1_000);
    expect(ticked.skipped).toBe(1);
    expect(launcher.calls).toHaveLength(0);
  });
});

describe("background-scheduler: run pruning", () => {
  it("prunes oldest runs beyond the cap, never the just-launched one", async () => {
    const store = new InMemoryScheduleStore();
    const launcher = new StubLauncher();
    const scheduler = new BackgroundScheduler({
      store,
      launcher,
      clock: () => T0,
      maxRunsPerSchedule: 3,
    });
    const schedule = makeSchedule();
    store.addSchedule(schedule);
    for (let i = 5; i >= 1; i -= 1) {
      store.addRun({
        runId: createScheduledRunId(),
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        trigger: "scheduled",
        status: "completed",
        scheduledFor: iso(T0 - i * HOUR),
        finishedAt: iso(T0 - i * HOUR + 1_000),
      });
    }
    await scheduler.tick(T0 + HOUR + 1_000);
    const runs = runsFor(store, schedule.id as string);
    expect(runs).toHaveLength(3);
    expect(runs.some((r) => r.status === "running")).toBe(true);
    expect(runs.every((r) => r.scheduledFor >= iso(T0 - 2 * HOUR))).toBe(true);
    expect(runs.some((r) => r.scheduledFor === iso(T0 - 5 * HOUR))).toBe(false);
  });
});

describe("background-scheduler: timer lifecycle", () => {
  it("runs a single timer; start/stop are idempotent", async () => {
    const scheduler = new BackgroundScheduler({
      store: new InMemoryScheduleStore(),
      launcher: new StubLauncher(),
      tickMs: 3_600_000,
    });
    expect(scheduler.isRunning).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    const timer = (scheduler as unknown as { _timer: unknown })._timer;
    scheduler.start();
    expect((scheduler as unknown as { _timer: unknown })._timer).toBe(timer);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it("requires store and launcher ports", () => {
    expect(
      () =>
        new BackgroundScheduler({
          store: undefined as never,
          launcher: new StubLauncher(),
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new BackgroundScheduler({
          store: new InMemoryScheduleStore(),
          launcher: undefined as never,
        }),
    ).toThrow(TypeError);
  });

  it("repairs a drifted pointer quietly on tick (no events, no launch)", async () => {
    const { store, launcher, sink, scheduler, schedule } = setup({
      nextRunAt: iso(T0 + 99 * HOUR),
    });
    const summary = await scheduler.tick(T0 + 30 * 60_000);
    expect(summary).toEqual({ launched: 0, skipped: 0, queued: 0, failed: 0 });
    expect(launcher.calls).toHaveLength(0);
    expect(sink.events).toHaveLength(0);
    expect(store.getSchedule(schedule.id as string)?.nextRunAt).toBe(iso(T0 + HOUR));
  });
});
