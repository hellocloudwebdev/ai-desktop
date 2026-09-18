// PR44: packages/ai-core — Schedule contract unit tests (CONTRACTS layer)

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DailyConfigSchema,
  DelayConfigSchema,
  IntervalConfigSchema,
  MAX_CATCH_UP_RUNS,
  MAX_DELAY_MS,
  MAX_RUNS_PER_SCHEDULE,
  MAX_SCHEDULES_PER_PROJECT,
  MAX_SCHEDULES_TOTAL,
  MAX_SCHEDULE_DESCRIPTION_LENGTH,
  MAX_SCHEDULE_ERROR_LENGTH,
  MAX_SCHEDULE_NAME_LENGTH,
  MAX_SCHEDULE_PROMPT_LENGTH,
  MIN_INTERVAL_MS,
  MissedPolicySchema,
  OnceConfigSchema,
  OverlapPolicySchema,
  SCHEDULER_TICK_MS_DEFAULT,
  SCHEDULE_EVENT_TYPES,
  ScheduleConfigSchema,
  ScheduledRunRecordSchema,
  ScheduledRunStatusSchema,
  ScheduledTaskRecordSchema,
  ScheduleErrorCodeSchema,
  ScheduleEventTypeSchema,
  ScheduleIdSchema,
  ScheduleInputSchema,
  ScheduleKindSchema,
  ScheduledRunIdSchema,
  TimezoneSchema,
  TriggerSchema,
  WeeklyConfigSchema,
  asScheduleId,
  asScheduledRunId,
  configMatchesKind,
  createScheduleId,
  createScheduledRunId,
  defaultMissedPolicyForKind,
  isLegalScheduleTransition,
  isValidTimezone,
  parseScheduleId,
  parseScheduledRunId,
  scheduleEventType,
  toScheduleError,
  validateScheduleInput,
} from "./schedules.js";
import { isUlid } from "@ai-desktop/shared";

function makeRecord(overrides: Record<string, unknown> = {}) {
  const ts = new Date("2026-09-18T00:00:00.000Z").toISOString();
  return {
    id: createScheduleId(),
    projectId: "proj-1",
    name: "Nightly review",
    prompt: "Review today's changes and summarize",
    kind: "daily",
    config: { hour: 9, minute: 30 },
    timezone: "UTC",
    enabled: true,
    missedPolicy: "skip",
    overlapPolicy: "skip",
    createdAt: ts,
    updatedAt: ts,
    nextRunAt: new Date("2026-09-19T09:30:00.000Z").toISOString(),
    runCount: 0,
    missedCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: createScheduledRunId(),
    scheduleId: createScheduleId(),
    projectId: "proj-1",
    trigger: "scheduled",
    status: "pending",
    scheduledFor: new Date("2026-09-19T09:30:00.000Z").toISOString(),
    ...overrides,
  };
}

describe("schedules: branded ids", () => {
  it("generates valid ULIDs distinct across schedule/run/task namespaces", () => {
    const sid = createScheduleId();
    const rid = createScheduledRunId();
    expect(isUlid(sid)).toBe(true);
    expect(isUlid(rid)).toBe(true);
    expect(sid).not.toBe(rid);
    expect(ScheduleIdSchema.safeParse(sid).success).toBe(true);
    expect(ScheduledRunIdSchema.safeParse(rid).success).toBe(true);
    expect(ScheduleIdSchema.safeParse("too-short").success).toBe(false);
    expect(ScheduledRunIdSchema.safeParse("!!!").success).toBe(false);
  });

  it("parses valid ULIDs and throws TypeError on malformed input", () => {
    const raw = createScheduleId().toLowerCase();
    expect(parseScheduleId(raw)).toBe(raw.toUpperCase());
    expect(parseScheduledRunId(raw)).toBe(raw.toUpperCase());
    expect(() => parseScheduleId("bad-id")).toThrow(TypeError);
    expect(() => parseScheduledRunId("bad-id")).toThrow(TypeError);
    expect(asScheduleId("x")).toBe("x");
    expect(asScheduledRunId("y")).toBe("y");
  });
});

describe("schedules: kinds and per-kind config bounds (no cron)", () => {
  it("accepts exactly the five documented kinds", () => {
    for (const kind of ["once", "delay", "interval", "daily", "weekly"]) {
      expect(ScheduleKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(ScheduleKindSchema.safeParse("cron").success).toBe(false);
    expect(ScheduleKindSchema.safeParse("every").success).toBe(false);
    expect(ScheduleKindSchema.safeParse("").success).toBe(false);
  });

  it("validates once { runAt } as an ISO UTC timestamp", () => {
    expect(OnceConfigSchema.safeParse({ runAt: "2026-09-19T09:30:00.000Z" }).success).toBe(true);
    expect(OnceConfigSchema.safeParse({ runAt: "tomorrow 9am" }).success).toBe(false);
    expect(OnceConfigSchema.safeParse({}).success).toBe(false);
  });

  it("bounds delayMs/everyMs structurally (1..1 year); floor enforced by validator", () => {
    expect(DelayConfigSchema.safeParse({ delayMs: 60_000 }).success).toBe(true);
    expect(IntervalConfigSchema.safeParse({ everyMs: 3_600_000 }).success).toBe(true);
    expect(DelayConfigSchema.safeParse({ delayMs: 0 }).success).toBe(false);
    expect(DelayConfigSchema.safeParse({ delayMs: -5 }).success).toBe(false);
    expect(IntervalConfigSchema.safeParse({ everyMs: 1.5 }).success).toBe(false);
    expect(IntervalConfigSchema.safeParse({ everyMs: MAX_DELAY_MS + 1 }).success).toBe(false);
    expect(MAX_DELAY_MS).toBe(365 * 24 * 3600 * 1000);
  });

  it("bounds daily/weekly wall-clock fields", () => {
    expect(DailyConfigSchema.safeParse({ hour: 0, minute: 0 }).success).toBe(true);
    expect(DailyConfigSchema.safeParse({ hour: 23, minute: 59 }).success).toBe(true);
    expect(DailyConfigSchema.safeParse({ hour: 24, minute: 0 }).success).toBe(false);
    expect(DailyConfigSchema.safeParse({ hour: 9, minute: 60 }).success).toBe(false);
    expect(WeeklyConfigSchema.safeParse({ weekday: 0, hour: 9, minute: 0 }).success).toBe(true);
    expect(WeeklyConfigSchema.safeParse({ weekday: 6, hour: 9, minute: 0 }).success).toBe(true);
    expect(WeeklyConfigSchema.safeParse({ weekday: 7, hour: 9, minute: 0 }).success).toBe(false);
    expect(WeeklyConfigSchema.safeParse({ weekday: -1, hour: 9, minute: 0 }).success).toBe(false);
  });

  it("keeps the config union disjoint (weekly never collapses to daily)", () => {
    const parsed = ScheduleConfigSchema.parse({ weekday: 1, hour: 9, minute: 30 });
    expect(parsed).toEqual({ weekday: 1, hour: 9, minute: 30 });
    expect("weekday" in parsed).toBe(true);
    expect(ScheduleConfigSchema.safeParse({ cron: "* * * *" }).success).toBe(false);
  });

  it("matches configs to kinds structurally", () => {
    expect(configMatchesKind("once", { runAt: "2026-09-19T09:30:00.000Z" })).toBe(true);
    expect(configMatchesKind("delay", { delayMs: 60_000 })).toBe(true);
    expect(configMatchesKind("interval", { everyMs: 60_000 })).toBe(true);
    expect(configMatchesKind("daily", { hour: 9, minute: 30 })).toBe(true);
    expect(configMatchesKind("weekly", { weekday: 1, hour: 9, minute: 30 })).toBe(true);
    expect(configMatchesKind("interval", { runAt: "2026-09-19T09:30:00.000Z" })).toBe(false);
    expect(configMatchesKind("daily", { weekday: 1, hour: 9, minute: 30 })).toBe(false);
    expect(configMatchesKind("weekly", { hour: 9, minute: 30 })).toBe(false);
    expect(configMatchesKind("once", null)).toBe(false);
    expect(configMatchesKind("once", "nope")).toBe(false);
  });
});

describe("schedules: policies, triggers, run statuses", () => {
  it("accepts the documented policy/trigger/status vocabularies", () => {
    expect(MissedPolicySchema.safeParse("skip").success).toBe(true);
    expect(MissedPolicySchema.safeParse("run_once").success).toBe(true);
    expect(MissedPolicySchema.safeParse("run-all").success).toBe(false);
    expect(OverlapPolicySchema.safeParse("skip").success).toBe(true);
    expect(OverlapPolicySchema.safeParse("queue_one").success).toBe(true);
    expect(OverlapPolicySchema.safeParse("parallel").success).toBe(false);
    for (const t of ["scheduled", "manual", "recovery"]) {
      expect(TriggerSchema.safeParse(t).success).toBe(true);
    }
    expect(TriggerSchema.safeParse("cron").success).toBe(false);
    for (const s of ["pending", "running", "completed", "failed", "skipped", "cancelled"]) {
      expect(ScheduledRunStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(ScheduledRunStatusSchema.safeParse("queued").success).toBe(false);
  });

  it("defaults missed policy by kind (skip recurring, run_once one-shot)", () => {
    expect(defaultMissedPolicyForKind("interval")).toBe("skip");
    expect(defaultMissedPolicyForKind("daily")).toBe("skip");
    expect(defaultMissedPolicyForKind("weekly")).toBe("skip");
    expect(defaultMissedPolicyForKind("once")).toBe("run_once");
    expect(defaultMissedPolicyForKind("delay")).toBe("run_once");
  });

  it("treats only the enabled toggle as a legal transition", () => {
    expect(isLegalScheduleTransition(true, false)).toBe(true);
    expect(isLegalScheduleTransition(false, true)).toBe(true);
    expect(isLegalScheduleTransition(true, true)).toBe(false);
    expect(isLegalScheduleTransition(false, false)).toBe(false);
  });
});

describe("schedules: timezone validation (Intl only)", () => {
  it("accepts UTC and IANA names", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(TimezoneSchema.safeParse("UTC").success).toBe(true);
    expect(TimezoneSchema.safeParse("Asia/Kolkata").success).toBe(true);
  });

  it("rejects unknown zones and non-strings without throwing", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("   ")).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
    expect(isValidTimezone("x".repeat(129))).toBe(false);
    expect(TimezoneSchema.safeParse("Not/AZone").success).toBe(false);
    expect(TimezoneSchema.safeParse("").success).toBe(false);
  });
});

describe("schedules: record schemas", () => {
  it("accepts a minimal valid schedule record", () => {
    const parsed = ScheduledTaskRecordSchema.parse(makeRecord());
    expect(parsed.runCount).toBe(0);
    expect(parsed.missedCount).toBe(0);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("accepts optional description/lastRun fields for every kind", () => {
    const ts = new Date("2026-09-18T12:00:00.000Z").toISOString();
    const parsed = ScheduledTaskRecordSchema.parse(
      makeRecord({
        kind: "weekly",
        config: { weekday: 5, hour: 18, minute: 0 },
        description: "Friday ship-room notes",
        lastRunAt: ts,
        lastRunStatus: "completed",
        runCount: 4,
        missedCount: 1,
      }),
    );
    expect(parsed.lastRunStatus).toBe("completed");
    expect(parsed.runCount).toBe(4);
  });

  it("rejects missing projectId, empty/overlong names, and overlong prompts", () => {
    expect(() => ScheduledTaskRecordSchema.parse(makeRecord({ projectId: "" }))).toThrow();
    expect(() => ScheduledTaskRecordSchema.parse(makeRecord({ name: "" }))).toThrow();
    expect(() => ScheduledTaskRecordSchema.parse(makeRecord({ name: "n".repeat(121) }))).toThrow();
    expect(() =>
      ScheduledTaskRecordSchema.parse(makeRecord({ prompt: "p".repeat(4001) })),
    ).toThrow();
    expect(() =>
      ScheduledTaskRecordSchema.parse(makeRecord({ description: "d".repeat(2001) })),
    ).toThrow();
    expect(MAX_SCHEDULE_NAME_LENGTH).toBe(120);
    expect(MAX_SCHEDULE_PROMPT_LENGTH).toBe(4000);
    expect(MAX_SCHEDULE_DESCRIPTION_LENGTH).toBe(2000);
    expect(MAX_SCHEDULE_ERROR_LENGTH).toBe(2000);
  });

  it("rejects invalid timezones, negative counters, and non-1 schema versions", () => {
    expect(() =>
      ScheduledTaskRecordSchema.parse(makeRecord({ timezone: "Mars/Olympus" })),
    ).toThrow();
    expect(() => ScheduledTaskRecordSchema.parse(makeRecord({ runCount: -1 }))).toThrow();
    expect(() => ScheduledTaskRecordSchema.parse(makeRecord({ missedCount: -1 }))).toThrow();
    expect(() => ScheduledTaskRecordSchema.parse(makeRecord({ schemaVersion: 2 }))).toThrow();
  });

  it("accepts a run record with optional linkage fields", () => {
    const parsed = ScheduledRunRecordSchema.parse(makeRun());
    expect(parsed.status).toBe("pending");
    expect(parsed.backgroundTaskId).toBeUndefined();
    const linked = ScheduledRunRecordSchema.parse(
      makeRun({
        status: "failed",
        error: "launch blew up",
        startedAt: "2026-09-19T09:30:01.000Z",
        finishedAt: "2026-09-19T09:30:02.000Z",
      }),
    );
    expect(linked.error).toBe("launch blew up");
  });

  it("rejects run records with bad ids, bad status, or overlong errors", () => {
    expect(() => ScheduledRunRecordSchema.parse(makeRun({ runId: "nope" }))).toThrow();
    expect(() => ScheduledRunRecordSchema.parse(makeRun({ status: "queued" }))).toThrow();
    expect(() => ScheduledRunRecordSchema.parse(makeRun({ trigger: "cron" }))).toThrow();
    expect(() => ScheduledRunRecordSchema.parse(makeRun({ error: "e".repeat(2001) }))).toThrow();
    expect(() => ScheduledRunRecordSchema.parse(makeRun({ projectId: "" }))).toThrow();
  });
});

describe("schedules: validateScheduleInput", () => {
  it("accepts a minimal input and applies documented defaults", () => {
    const out = validateScheduleInput({
      projectId: "p1",
      name: "Daily standup notes",
      prompt: "Summarize yesterday's commits",
      kind: "daily",
      config: { hour: 9, minute: 0 },
    });
    expect(out.timezone).toBe("UTC");
    expect(out.enabled).toBe(true);
    expect(out.missedPolicy).toBe("skip");
    expect(out.overlapPolicy).toBe("skip");
    expect(out.kind).toBe("daily");
  });

  it("defaults missedPolicy to run_once for once/delay", () => {
    const once = validateScheduleInput({
      projectId: "p1",
      name: "One shot",
      prompt: "Do it once",
      kind: "once",
      config: { runAt: "2026-09-19T09:30:00.000Z" },
    });
    expect(once.missedPolicy).toBe("run_once");
    const delay = validateScheduleInput({
      projectId: "p1",
      name: "Delayed",
      prompt: "Do it later",
      kind: "delay",
      config: { delayMs: 3_600_000 },
    });
    expect(delay.missedPolicy).toBe("run_once");
  });

  it("honours explicit timezone/policies/enabled", () => {
    const out = validateScheduleInput({
      projectId: "p1",
      name: "Kolkata report",
      prompt: "Morning report",
      kind: "daily",
      config: { hour: 9, minute: 0 },
      timezone: "Asia/Kolkata",
      enabled: false,
      missedPolicy: "run_once",
      overlapPolicy: "queue_one",
    });
    expect(out.timezone).toBe("Asia/Kolkata");
    expect(out.enabled).toBe(false);
    expect(out.missedPolicy).toBe("run_once");
    expect(out.overlapPolicy).toBe("queue_one");
  });

  it("throws ZodError (not a bare Error) for every rejection class", () => {
    const badInputs: unknown[] = [
      { projectId: "", name: "n", prompt: "p", kind: "daily", config: { hour: 9, minute: 0 } },
      {
        projectId: "p1",
        name: "n",
        prompt: "p",
        kind: "interval",
        config: { runAt: "2026-09-19T09:30:00.000Z" },
      },
      {
        projectId: "p1",
        name: "n",
        prompt: "p",
        kind: "daily",
        config: { hour: 9, minute: 0 },
        timezone: "Mars/Olympus",
      },
      {
        projectId: "p1",
        name: "n",
        prompt: "p",
        kind: "interval",
        config: { everyMs: 1_000 },
      },
      {
        projectId: "p1",
        name: "n",
        prompt: "p",
        kind: "delay",
        config: { delayMs: 5_000 },
      },
    ];
    for (const bad of badInputs) {
      try {
        validateScheduleInput(bad);
        expect.unreachable(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
      }
    }
    // The base input schema itself rejects malformed payloads.
    expect(ScheduleInputSchema.safeParse({}).success).toBe(false);
  });

  it("allows a test-only min-interval override via options (never via data)", () => {
    const out = validateScheduleInput(
      {
        projectId: "p1",
        name: "fast test",
        prompt: "tick fast",
        kind: "interval",
        config: { everyMs: 1_000 },
      },
      { minIntervalMs: 1_000 },
    );
    expect(out.kind).toBe("interval");
    // The same payload without the override still throws.
    expect(() =>
      validateScheduleInput({
        projectId: "p1",
        name: "fast test",
        prompt: "tick fast",
        kind: "interval",
        config: { everyMs: 1_000 },
      }),
    ).toThrow(ZodError);
  });

  it("refuses secret-bearing text as a ZodError without echoing the value", () => {
    const sensitive = "api_key=SUPER-SENSITIVE-SCHEDULE-VALUE";
    try {
      validateScheduleInput({
        projectId: "p1",
        name: "nightly",
        prompt: `Summarize with ${sensitive}`,
        kind: "daily",
        config: { hour: 9, minute: 0 },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      expect(String(err)).toContain("secret-refused");
      expect(String(err)).not.toContain("SUPER-SENSITIVE-SCHEDULE-VALUE");
    }
  });
});

describe("schedules: error helper", () => {
  it("returns the {code, message} shape and rejects unknown codes", () => {
    expect(toScheduleError("not-found", "missing")).toEqual({
      code: "not-found",
      message: "missing",
    });
    expect(toScheduleError("schedule-limit", "too many").code).toBe("schedule-limit");
    expect(() => toScheduleError("nope" as never, "bad")).toThrow();
    for (const code of [
      "not-found",
      "project-mismatch",
      "validation-error",
      "secret-refused",
      "schedule-limit",
      "task-active",
      "storage-error",
    ]) {
      expect(ScheduleErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});

describe("schedules: event allowlist", () => {
  it("builds schedule.* names for all 11 allowlisted types", () => {
    expect(scheduleEventType("created")).toBe("schedule.created");
    expect(scheduleEventType("due")).toBe("schedule.due");
    expect(scheduleEventType("run.started")).toBe("schedule.run.started");
    expect(scheduleEventType("run.recovered")).toBe("schedule.run.recovered");
    expect(SCHEDULE_EVENT_TYPES).toHaveLength(11);
    for (const t of SCHEDULE_EVENT_TYPES) {
      expect(ScheduleEventTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects background-style and ad-hoc types", () => {
    expect(() => scheduleEventType("task.background.started")).toThrow();
    expect(() => scheduleEventType("started")).toThrow();
    expect(() => scheduleEventType("")).toThrow();
    expect(() => scheduleEventType("run.cancelled")).toThrow();
  });
});

describe("schedules: caps sanity", () => {
  it("keeps schedule caps at their canonical values", () => {
    expect(MAX_SCHEDULES_TOTAL).toBe(32);
    expect(MAX_SCHEDULES_PER_PROJECT).toBe(8);
    expect(MIN_INTERVAL_MS).toBe(60_000);
    expect(MAX_RUNS_PER_SCHEDULE).toBe(50);
    expect(MAX_CATCH_UP_RUNS).toBe(1);
    expect(SCHEDULER_TICK_MS_DEFAULT).toBe(30_000);
    expect(MAX_SCHEDULES_TOTAL).toBeGreaterThan(MAX_SCHEDULES_PER_PROJECT);
  });
});
