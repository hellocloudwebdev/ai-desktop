// PR44: apps/desktop — DesktopSchedulerService Tests
//
// Thin-orchestration coverage: create->persisted+nextRunAt, validation,
// enable/disable, manual runNow (trigger=manual, project binding), due-tick
// launches, overlap skip/queue_one, missed skip/run_once, catch-up cap,
// history bound, idempotent recovery, cross-project denial, secret refusal,
// delete-preserves-runs, and disable-never-kills-active. No Electron is
// needed anywhere in this suite; time is injected via clock (never real
// waiting).

import { describe, expect, it } from "vitest";
import type { AIEvent, ConversationId } from "@ai-desktop/ai-core";
import type { ScheduledRunRow, ScheduledTaskRow } from "@ai-desktop/storage";
import { createTaskId } from "@ai-desktop/shared";
import { DesktopSchedulerService, MAX_SCHEDULE_RUN_HISTORY } from "../scheduler-service.js";

type DelegateMode = "immediate" | "gated" | "throwing";

class StubBackgroundDelegate {
  mode: DelegateMode = "immediate";
  readonly started: Array<{ goal: string; projectId?: string }> = [];
  readonly cancelled: string[] = [];
  private readonly gateResolvers: Array<(result: { taskId: string }) => void> = [];

  async startTask(input: {
    goal: string;
    projectId?: string;
    conversationId?: ConversationId;
  }): Promise<{ taskId: string }> {
    this.started.push({ goal: input.goal, projectId: input.projectId });
    if (this.mode === "gated") {
      return new Promise<{ taskId: string }>((resolve) => {
        this.gateResolvers.push(resolve);
      });
    }
    if (this.mode === "throwing") {
      throw new Error("queue-full: background task queue is full (16 queued)");
    }
    return { taskId: createTaskId() };
  }

  resolveNextGated(): void {
    const resolve = this.gateResolvers.shift();
    resolve?.({ taskId: createTaskId() });
  }

  cancelTask(taskId: string): boolean {
    this.cancelled.push(taskId);
    return true;
  }
}

class InMemoryScheduleStore {
  readonly rows = new Map<string, ScheduledTaskRow>();

  async upsert(record: ScheduledTaskRow): Promise<void> {
    this.rows.set(record.scheduleId, { ...record });
  }

  async get(scheduleId: string): Promise<ScheduledTaskRow | null> {
    return this.rows.get(scheduleId) ?? null;
  }

  async listByProject(projectId: string): Promise<ScheduledTaskRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async listAll(): Promise<ScheduledTaskRow[]> {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async listEnabled(): Promise<ScheduledTaskRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.enabled)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(scheduleId: string): Promise<boolean> {
    return this.rows.delete(scheduleId);
  }
}

class InMemoryRunStore {
  readonly rows = new Map<string, ScheduledRunRow>();

  async create(record: ScheduledRunRow): Promise<void> {
    this.rows.set(record.runId, { ...record });
  }

  async get(runId: string): Promise<ScheduledRunRow | null> {
    return this.rows.get(runId) ?? null;
  }

  async listBySchedule(scheduleId: string, limit?: number): Promise<ScheduledRunRow[]> {
    const take = limit ?? 20;
    return [...this.rows.values()]
      .filter((row) => row.scheduleId === scheduleId)
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .slice(0, take);
  }

  async listUnfinished(scheduleId?: string): Promise<ScheduledRunRow[]> {
    return [...this.rows.values()].filter(
      (row) =>
        (row.status === "pending" || row.status === "running") &&
        (scheduleId === undefined || row.scheduleId === scheduleId),
    );
  }

  async update(
    runId: string,
    patch: {
      backgroundTaskId?: string | null;
      status?: string;
      startedAt?: number | null;
      finishedAt?: number | null;
      error?: string | null;
    },
  ): Promise<boolean> {
    const current = this.rows.get(runId);
    if (!current) return false;
    const next: ScheduledRunRow = { ...current };
    if (patch.backgroundTaskId !== undefined) next.backgroundTaskId = patch.backgroundTaskId;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt;
    if (patch.error !== undefined) next.error = patch.error;
    this.rows.set(runId, next);
    return true;
  }

  async pruneRuns(scheduleId: string, keepLatest: number): Promise<number> {
    const ordered = [...this.rows.values()]
      .filter((row) => row.scheduleId === scheduleId)
      .sort((a, b) => b.scheduledFor - a.scheduledFor);
    const stale = ordered.slice(Math.max(0, keepLatest));
    for (const row of stale) this.rows.delete(row.runId);
    return stale.length;
  }
}

class StubEventBus {
  readonly events: AIEvent[] = [];

  async publish(event: Readonly<AIEvent>): Promise<void> {
    this.events.push(event as AIEvent);
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

const T0 = Date.parse("2026-09-18T10:00:00.000Z");

function createHarness() {
  let nowMs = T0;
  const background = new StubBackgroundDelegate();
  const schedules = new InMemoryScheduleStore();
  const runs = new InMemoryRunStore();
  const bus = new StubEventBus();
  const storage = new StubEventRepository();
  const service = new DesktopSchedulerService({
    backgroundTaskService: background,
    scheduleRepo: schedules,
    runRepo: runs,
    eventBus: bus,
    storage,
    clock: () => nowMs,
    tickMs: 25,
  });
  return {
    background,
    schedules,
    runs,
    bus,
    storage,
    service,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function eventTypes(bus: StubEventBus): string[] {
  return bus.events.map((event) => (event as { type: string }).type);
}

describe("apps/desktop: DesktopSchedulerService (PR44)", () => {
  it("creates an interval schedule with computed nextRunAt and persists the row", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly index rebuild",
      prompt: "Rebuild the project search index and report what changed.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    expect(schedule.projectId).toBe("proj-a");
    expect(schedule.enabled).toBe(true);
    expect(schedule.missedPolicy).toBe("skip");
    expect(schedule.overlapPolicy).toBe("skip");
    expect(schedule.nextRunAt).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(schedule.runCount).toBe(0);
    const row = await h.schedules.get(schedule.scheduleId);
    expect(row?.projectId).toBe("proj-a");
    expect(row?.kind).toBe("interval");
    expect(eventTypes(h.bus)).toContain("schedule.created");
    expect(h.storage.appended).toHaveLength(h.bus.events.length);
  });

  it("computes next runs for once/delay/daily/weekly kinds", async () => {
    const h = createHarness();
    const once = await h.service.create({
      projectId: "proj-a",
      name: "Once",
      prompt: "Do it once.",
      schedule: { kind: "once", runAt: "2026-09-18T12:00:00.000Z" },
      timezone: "UTC",
    });
    expect(once.nextRunAt).toBe("2026-09-18T12:00:00.000Z");
    const delay = await h.service.create({
      projectId: "proj-a",
      name: "Delay",
      prompt: "Do it soon.",
      schedule: { kind: "delay", delayMs: 5_000 },
      timezone: "UTC",
    });
    expect(delay.nextRunAt).toBe(new Date(T0 + 5_000).toISOString());
    const daily = await h.service.create({
      projectId: "proj-a",
      name: "Daily",
      prompt: "Daily summary.",
      schedule: { kind: "daily", dailyTime: "09:00" },
      timezone: "UTC",
    });
    expect(daily.nextRunAt).toBe("2026-09-19T09:00:00.000Z");
    const weekly = await h.service.create({
      projectId: "proj-a",
      name: "Weekly",
      prompt: "Weekly review.",
      schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 30 },
      timezone: "UTC",
    });
    expect(weekly.nextRunAt).toBe("2026-09-21T09:30:00.000Z");
  });

  it("rejects invalid input without persisting or launching", async () => {
    const h = createHarness();
    const base = {
      projectId: "proj-a",
      name: "Fallback",
      prompt: "Fallback work.",
      timezone: "UTC",
      schedule: { kind: "interval", intervalMs: 60_000 },
    };
    const bad: unknown[] = [
      { ...base, name: "" },
      { ...base, prompt: "" },
      { ...base, schedule: { kind: "cron", expression: "* * *" } },
      { ...base, schedule: { kind: "interval", intervalMs: 5_000 } },
      { ...base, schedule: { kind: "daily", dailyTime: "25:00" } },
      { ...base, schedule: { kind: "once", runAt: "not-a-time" } },
      { ...base, timezone: "Mars/Olympus" },
    ];
    for (const [index, candidate] of bad.entries()) {
      await expect(h.service.create(candidate as never), `case ${index}`).rejects.toThrow(
        "validation-error",
      );
    }
    expect(h.schedules.rows.size).toBe(0);
    expect(h.background.started).toHaveLength(0);
  });

  it("refuses secret material without persisting", async () => {
    const h = createHarness();
    await expect(
      h.service.create({
        projectId: "proj-a",
        name: "Nightly",
        prompt: "Rotate the deploy token api_key=sk-live-abc123 and report.",
        schedule: { kind: "interval", intervalMs: 60_000 },
        timezone: "UTC",
      }),
    ).rejects.toThrow("secret-refused");
    expect(h.schedules.rows.size).toBe(0);
    expect(h.background.started).toHaveLength(0);
  });

  it("enforces the workspace-wide schedule cap", async () => {
    const h = createHarness();
    for (let i = 0; i < 32; i += 1) {
      await h.service.create({
        projectId: "proj-a",
        name: `Schedule ${i}`,
        prompt: `Do work item ${i}.`,
        schedule: { kind: "interval", intervalMs: 60_000 },
        timezone: "UTC",
      });
    }
    await expect(
      h.service.create({
        projectId: "proj-a",
        name: "One too many",
        prompt: "Extra work.",
        schedule: { kind: "interval", intervalMs: 60_000 },
        timezone: "UTC",
      }),
    ).rejects.toThrow("limit-reached");
  });

  it("disable stops future runs and enable resumes them", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    const disabled = await h.service.disable(schedule.scheduleId, "proj-a");
    expect(disabled.enabled).toBe(false);
    h.advance(30 * 60_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(0);
    const enabled = await h.service.enable(schedule.scheduleId, "proj-a");
    expect(enabled.enabled).toBe(true);
    // Past the hourly slot but within one period: due, not missed.
    h.advance(40 * 60_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
    expect(eventTypes(h.bus)).toContain("schedule.disabled");
    expect(eventTypes(h.bus)).toContain("schedule.enabled");
  });

  it("runNow launches a manual run with the same projectId and keeps the cadence", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    const before = schedule.nextRunAt;
    const outcome = await h.service.runNow(schedule.scheduleId, "proj-a");
    expect(h.background.started).toHaveLength(1);
    expect(h.background.started[0]?.projectId).toBe("proj-a");
    expect(h.background.started[0]?.goal).toBe("Hourly work item.");
    expect(outcome.run.trigger).toBe("manual");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.backgroundTaskId).toBeTruthy();
    expect(outcome.schedule.runCount).toBe(1);
    expect(outcome.schedule.lastRunStatus).toBe("completed");
    expect(outcome.schedule.nextRunAt).toBe(before);
    const runs = await h.service.listRuns(schedule.scheduleId, "proj-a");
    expect(runs).toHaveLength(1);
  });

  it("due tick launches with project binding and advances the cadence", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    h.advance(3_600_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
    expect(h.background.started[0]?.projectId).toBe("proj-a");
    const after = await h.service.get(schedule.scheduleId, "proj-a");
    expect(after.runCount).toBe(1);
    expect(Date.parse(after.nextRunAt as string)).toBeGreaterThan(h.now());
    expect(eventTypes(h.bus)).toContain("schedule.run.started");
  });

  it("overlap skip records a skipped run and reschedules without duplicating", async () => {
    const h = createHarness();
    h.background.mode = "gated";
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
      overlapPolicy: "skip",
    });
    h.advance(3_600_000);
    await h.service.tick();
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
    const runs = await h.service.listRuns(schedule.scheduleId, "proj-a", 10);
    const skipped = runs.find((run) => run.status === "skipped");
    expect(skipped?.error).toContain("skipped");
    h.background.resolveNextGated();
    await settle();
    expect(h.background.started).toHaveLength(1);
    const after = await h.service.get(schedule.scheduleId, "proj-a");
    expect(Date.parse(after.nextRunAt as string)).toBeGreaterThan(h.now());
  });

  it("overlap queue_one defers exactly one launch", async () => {
    const h = createHarness();
    h.background.mode = "gated";
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
      overlapPolicy: "queue_one",
    });
    h.advance(3_600_000);
    await h.service.tick();
    await h.service.tick();
    await settle();
    // One active launch plus one deferred request; nothing duplicated.
    expect(h.background.started).toHaveLength(1);
    // A further occurrence while a request is already queued skips.
    h.advance(3_600_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
    const mid = await h.service.listRuns(schedule.scheduleId, "proj-a", 10);
    expect(mid.find((run) => run.status === "skipped")?.error).toContain("skipped");
    h.background.resolveNextGated();
    await settle();
    expect(h.background.started).toHaveLength(2);
    h.advance(60_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(2);
  });

  it("missed skip counts occurrences without launching", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
      missedPolicy: "skip",
    });
    // nextRunAt sits one period out, so the overdue window is 3.5 periods.
    h.advance(4.5 * 3_600_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(0);
    const after = await h.service.get(schedule.scheduleId, "proj-a");
    expect(after.missedCount).toBe(4);
    expect(Date.parse(after.nextRunAt as string)).toBeGreaterThan(h.now());
    expect(eventTypes(h.bus)).toContain("schedule.run.skipped");
  });

  it("missed run_once catches up at most once", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
      missedPolicy: "run_once",
    });
    // nextRunAt sits one period out, so the overdue window is 10 periods.
    h.advance(11 * 3_600_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
    const after = await h.service.get(schedule.scheduleId, "proj-a");
    expect(after.missedCount).toBe(10);
    expect(after.runCount).toBe(1);
    expect(Date.parse(after.nextRunAt as string)).toBeGreaterThan(h.now());
    const runs = await h.service.listRuns(schedule.scheduleId, "proj-a", 10);
    expect(runs.find((run) => run.status === "completed")?.trigger).toBe("recovery");
  });

  it("spends a missed one-shot on skip and launches it once on run_once", async () => {
    const h = createHarness();
    const past = new Date(T0 - 2 * 3_600_000).toISOString();
    const skipped = await h.service.create({
      projectId: "proj-a",
      name: "Past once",
      prompt: "Past work.",
      schedule: { kind: "once", runAt: past },
      timezone: "UTC",
      missedPolicy: "skip",
    });
    const caughtUp = await h.service.create({
      projectId: "proj-a",
      name: "Past once catchup",
      prompt: "Past catchup work.",
      schedule: { kind: "once", runAt: past },
      timezone: "UTC",
      missedPolicy: "run_once",
    });
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
    const skippedAfter = await h.service.get(skipped.scheduleId, "proj-a");
    expect(skippedAfter.nextRunAt).toBeNull();
    expect(skippedAfter.missedCount).toBe(1);
    const caughtAfter = await h.service.get(caughtUp.scheduleId, "proj-a");
    expect(caughtAfter.nextRunAt).toBeNull();
    expect(caughtAfter.runCount).toBe(1);
  });

  it("retention-prunes run history to 50 rows per schedule", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    for (let i = 0; i < 60; i += 1) {
      await h.service.runNow(schedule.scheduleId, "proj-a");
    }
    const runs = await h.service.listRuns(schedule.scheduleId, "proj-a", 100);
    expect(runs.length).toBeLessThanOrEqual(MAX_SCHEDULE_RUN_HISTORY);
    expect(runs.length).toBeLessThanOrEqual(50);
    const stored = await h.runs.listBySchedule(schedule.scheduleId, 100);
    expect(stored.length).toBeLessThanOrEqual(50);
  });

  it("recovery closes stale runs, catches up once, and is idempotent", async () => {
    const h = createHarness();
    const scheduleId = createTaskId();
    await h.schedules.upsert({
      scheduleId,
      projectId: "proj-a",
      name: "Seeded",
      description: null,
      prompt: "Seeded work.",
      kind: "interval",
      configJson: JSON.stringify({ kind: "interval", intervalMs: 3_600_000 }),
      timezone: "UTC",
      enabled: true,
      missedPolicy: "run_once",
      overlapPolicy: "skip",
      createdAt: T0 - 4 * 3_600_000,
      updatedAt: T0 - 4 * 3_600_000,
      nextRunAt: T0 - 2 * 3_600_000,
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
      missedCount: 0,
      schemaVersion: 1,
    });
    await h.runs.create({
      runId: createTaskId(),
      scheduleId,
      projectId: "proj-a",
      backgroundTaskId: null,
      trigger: "scheduled",
      status: "running",
      scheduledFor: T0 - 2 * 3_600_000,
      startedAt: T0 - 2 * 3_600_000,
      finishedAt: null,
      error: null,
    });
    const first = await h.service.recover();
    expect(first.schedules).toBe(1);
    expect(first.closed).toBe(1);
    expect(first.caughtUp).toBe(1);
    expect(h.background.started).toHaveLength(1);
    const runCount = (await h.runs.listBySchedule(scheduleId, 100)).length;
    const second = await h.service.recover();
    expect(second.caughtUp).toBe(0);
    expect(second.skipped).toBe(0);
    expect(h.background.started).toHaveLength(1);
    expect((await h.runs.listBySchedule(scheduleId, 100)).length).toBe(runCount);
  });

  it("recovery never launches for disabled schedules", async () => {
    const h = createHarness();
    const scheduleId = createTaskId();
    await h.schedules.upsert({
      scheduleId,
      projectId: "proj-a",
      name: "Disabled seeded",
      description: null,
      prompt: "Seeded work.",
      kind: "interval",
      configJson: JSON.stringify({ kind: "interval", intervalMs: 3_600_000 }),
      timezone: "UTC",
      enabled: false,
      missedPolicy: "run_once",
      overlapPolicy: "skip",
      createdAt: T0 - 4 * 3_600_000,
      updatedAt: T0 - 4 * 3_600_000,
      nextRunAt: T0 - 2 * 3_600_000,
      lastRunAt: null,
      lastRunStatus: null,
      runCount: 0,
      missedCount: 0,
      schemaVersion: 1,
    });
    await h.runs.create({
      runId: createTaskId(),
      scheduleId,
      projectId: "proj-a",
      backgroundTaskId: null,
      trigger: "scheduled",
      status: "pending",
      scheduledFor: T0 - 2 * 3_600_000,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    const summary = await h.service.recover();
    expect(summary.closed).toBe(1);
    expect(summary.caughtUp).toBe(0);
    expect(h.background.started).toHaveLength(0);
  });

  it("denies cross-project access without side effects", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    await expect(h.service.get(schedule.scheduleId, "proj-b")).rejects.toThrow("project-mismatch");
    await expect(
      h.service.update(schedule.scheduleId, "proj-b", { name: "Hijacked" }),
    ).rejects.toThrow("project-mismatch");
    await expect(h.service.enable(schedule.scheduleId, "proj-b")).rejects.toThrow(
      "project-mismatch",
    );
    await expect(h.service.disable(schedule.scheduleId, "proj-b")).rejects.toThrow(
      "project-mismatch",
    );
    await expect(h.service.delete(schedule.scheduleId, "proj-b")).rejects.toThrow(
      "project-mismatch",
    );
    await expect(h.service.runNow(schedule.scheduleId, "proj-b")).rejects.toThrow(
      "project-mismatch",
    );
    await expect(h.service.listRuns(schedule.scheduleId, "proj-b")).rejects.toThrow(
      "project-mismatch",
    );
    await expect(h.service.get("not-a-ulid", "proj-a")).rejects.toThrow("not-found");
    expect(h.background.started).toHaveLength(0);
    const intact = await h.service.get(schedule.scheduleId, "proj-a");
    expect(intact.name).toBe("Hourly");
  });

  it("delete stops future runs while preserving run history", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    await h.service.runNow(schedule.scheduleId, "proj-a");
    const outcome = await h.service.delete(schedule.scheduleId, "proj-a");
    expect(outcome.deleted).toBe(true);
    await expect(h.service.get(schedule.scheduleId, "proj-a")).rejects.toThrow("not-found");
    const preserved = await h.runs.listBySchedule(schedule.scheduleId, 100);
    expect(preserved).toHaveLength(1);
    h.advance(2 * 3_600_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
  });

  it("run history stays queryable after delete, scoped by the runs' own project", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    await h.service.runNow(schedule.scheduleId, "proj-a");
    await h.service.delete(schedule.scheduleId, "proj-a");
    const history = await h.service.listRuns(schedule.scheduleId, "proj-a", 10);
    expect(history).toHaveLength(1);
    expect(history[0]?.trigger).toBe("manual");
    // Wrong-project callers see an empty history (fail closed, no oracle).
    await expect(h.service.listRuns(schedule.scheduleId, "proj-b", 10)).resolves.toEqual([]);
  });

  it("disable never kills an active task", async () => {
    const h = createHarness();
    h.background.mode = "gated";
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    h.advance(3_600_000);
    await h.service.tick();
    const disabled = await h.service.disable(schedule.scheduleId, "proj-a");
    expect(disabled.enabled).toBe(false);
    expect(h.background.cancelled).toHaveLength(0);
    h.background.resolveNextGated();
    await settle();
    expect(h.background.started).toHaveLength(1);
    const runs = await h.service.listRuns(schedule.scheduleId, "proj-a", 10);
    expect(runs.find((run) => run.status === "completed")).toBeTruthy();
    h.advance(3_600_000);
    await h.service.tick();
    await settle();
    expect(h.background.started).toHaveLength(1);
  });

  it("manual runNow works on disabled schedules without enabling", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
      enabled: false,
    });
    const outcome = await h.service.runNow(schedule.scheduleId, "proj-a");
    expect(outcome.run.trigger).toBe("manual");
    expect(outcome.schedule.enabled).toBe(false);
    expect(h.background.started).toHaveLength(1);
  });

  it("start/stop timer lifecycle is idempotent", () => {
    const h = createHarness();
    h.service.start();
    h.service.start();
    h.service.stop();
    h.service.stop();
  });

  it("update recomputes nextRunAt only when the cadence changes", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    const renamed = await h.service.update(schedule.scheduleId, "proj-a", { name: "Renamed" });
    expect(renamed.name).toBe("Renamed");
    expect(renamed.nextRunAt).toBe(schedule.nextRunAt);
    h.advance(60_000);
    const rescheduled = await h.service.update(schedule.scheduleId, "proj-a", {
      schedule: { kind: "interval", intervalMs: 7_200_000 },
    });
    expect(rescheduled.nextRunAt).toBe(new Date(h.now() + 7_200_000).toISOString());
  });

  it("records failed handoffs as failed runs and reschedules", async () => {
    const h = createHarness();
    h.background.mode = "throwing";
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    h.advance(3_600_000);
    await h.service.tick();
    await settle();
    const runs = await h.service.listRuns(schedule.scheduleId, "proj-a", 10);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("queue-full");
    const after = await h.service.get(schedule.scheduleId, "proj-a");
    expect(after.lastRunStatus).toBe("failed");
    expect(Date.parse(after.nextRunAt as string)).toBeGreaterThan(h.now());
  });

  it("emits schedule.* events storage-first for every transition", async () => {
    const h = createHarness();
    const schedule = await h.service.create({
      projectId: "proj-a",
      name: "Hourly",
      prompt: "Hourly work item.",
      schedule: { kind: "interval", intervalMs: 3_600_000 },
      timezone: "UTC",
    });
    await h.service.runNow(schedule.scheduleId, "proj-a");
    const types = eventTypes(h.bus);
    expect(types).toContain("schedule.created");
    expect(types).toContain("schedule.run.started");
    for (const type of types) {
      expect(type.startsWith("schedule.")).toBe(true);
    }
    expect(h.storage.appended).toHaveLength(h.bus.events.length);
  });
});
