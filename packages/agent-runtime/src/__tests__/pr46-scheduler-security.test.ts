// PR46: packages/agent-runtime — Scheduler Security (adversarial)
import { describe, expect, it } from "vitest";
import {
  createScheduledRunId,
  createScheduleId,
  type ScheduledTaskRecord,
} from "@ai-desktop/ai-core";
import {
  BackgroundScheduler,
  InMemoryScheduleStore,
} from "../runtime/scheduling/background-scheduler.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-18T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function schedule(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: createScheduleId(),
    projectId: "proj-a",
    name: "Hourly",
    prompt: "Summarize.",
    kind: "interval",
    config: { everyMs: HOUR } as never,
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
  } as ScheduledTaskRecord;
}

describe("scheduler security: secret fail-closed + project binding", () => {
  it("secret-bearing schedule never launches (disabled + failed run)", async () => {
    const store = new InMemoryScheduleStore();
    const s = schedule({ prompt: "do it api_key=sk-live-12345678" });
    store.addSchedule(s);
    let launched = 0;
    const scheduler = new BackgroundScheduler({
      store,
      launcher: {
        launch: async () => {
          launched++;
          return { backgroundTaskId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never };
        },
      },
      clock: () => T0 + HOUR + 1000,
    });
    const summary = await scheduler.tick(T0 + HOUR + 1000);
    expect(launched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(store.getSchedule(s.id as string)?.enabled).toBe(false);
  });
  it("cross-project runNow rejected (project-mismatch, no launch)", async () => {
    const store = new InMemoryScheduleStore();
    const s = schedule();
    store.addSchedule(s);
    let launched = 0;
    const scheduler = new BackgroundScheduler({
      store,
      launcher: {
        launch: async () => {
          launched++;
          return { backgroundTaskId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never };
        },
      },
    });
    const res = await scheduler.runNow(s.id as string, "proj-b", "manual");
    expect("error" in res).toBe(true);
    expect(launched).toBe(0);
  });
  it("malformed ids rejected without launch", async () => {
    const store = new InMemoryScheduleStore();
    const scheduler = new BackgroundScheduler({
      store,
      launcher: { launch: async () => ({ backgroundTaskId: "x" as never }) },
    });
    const res = await scheduler.runNow("__proto__", "proj-a", "manual");
    expect("error" in res).toBe(true);
  });
});

describe("scheduler security: no duplicate execution + inert on arrival", () => {
  it("double tick launches at most one run per schedule (no duplicates)", async () => {
    const store = new InMemoryScheduleStore();
    const s = schedule();
    store.addSchedule(s);
    let launched = 0;
    const scheduler = new BackgroundScheduler({
      store,
      launcher: {
        launch: async () => {
          launched++;
          const { createTaskId } = await import("@ai-desktop/shared");
          return { backgroundTaskId: createTaskId() };
        },
      },
      clock: () => T0 + HOUR + 1000,
    });
    await scheduler.tick(T0 + HOUR + 1000);
    await scheduler.tick(T0 + HOUR + 1000);
    expect(launched).toBeLessThanOrEqual(1);
  });
  it("recover never launches and dedupes batch duplicates", async () => {
    const store = new InMemoryScheduleStore();
    const scheduler = new BackgroundScheduler({
      store,
      launcher: {
        launch: async () => {
          throw new Error("must-not-launch");
        },
      },
    });
    const s = schedule();
    const summary = await scheduler.recover([s, s], []);
    expect(summary.validated + summary.rejected).toBe(2);
  });
  it("run identity uniqueness via ledger (same runId replayed without duplicate write)", async () => {
    const store = new InMemoryScheduleStore();
    const s = schedule();
    const scheduler = new BackgroundScheduler({
      store,
      launcher: {
        launch: async () => ({ backgroundTaskId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA" as never }),
      },
    });
    const runId = createScheduledRunId();
    const run = {
      runId,
      scheduleId: s.id,
      projectId: "proj-a",
      trigger: "scheduled",
      status: "pending",
      scheduledFor: iso(T0),
    };
    const first = await scheduler.recover([s], [run]);
    const second = await scheduler.recover([s], [run]);
    expect(first.recoveredRuns).toBe(1);
    expect(second.recoveredRuns).toBe(1);
    expect(store.getAllRuns().filter((r) => String(r.runId) === String(runId)).length).toBe(1);
  });
});
