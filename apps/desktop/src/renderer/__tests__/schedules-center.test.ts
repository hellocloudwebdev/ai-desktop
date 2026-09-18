// PR44: renderer — Schedule Center tests (store/projection-level)
//
// Pure/store-level coverage for the Schedule Center renderer layer:
// grouping enabled vs disabled, form validation, project-isolation display,
// disconnect-requery through the local stub, secret hygiene, trigger
// labels, no-execute-on-partial-form gating, and render caps.
// Component-contract assertions follow the repo's established
// source-assertion pattern (pure, no Electron, no DOM).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_SCHEDULE_RUNS,
  MAX_SCHEDULES_TOTAL,
  MAX_SCHEDULE_CATCH_UP,
  MAX_SCHEDULE_DISPLAY_NAME,
  MAX_SCHEDULE_DISPLAY_PROMPT,
  MAX_SCHEDULE_ROWS_PER_SECTION,
  MAX_SCHEDULE_RUNS_SHOWN,
  MIN_SCHEDULE_INTERVAL_MS,
  OVERLAP_POLICIES,
  MISSED_POLICIES,
  SCHEDULE_KINDS,
  SCHEDULE_RUN_STATUSES,
  SCHEDULE_RUN_TRIGGERS,
  countEnabledSchedules,
  createLocalScheduleStub,
  createSchedule,
  deleteSchedule,
  describeSchedule,
  disableSchedule,
  enableSchedule,
  fetchSchedule,
  fetchScheduleList,
  fetchScheduleRuns,
  filterSchedulesByProject,
  formatNextRunCountdown,
  formatScheduleRunDuration,
  getScheduleCommands,
  groupSchedules,
  isScheduleFormValid,
  isValidTimezone,
  normalizeScheduleRunView,
  normalizeScheduleRunViews,
  normalizeScheduleView,
  normalizeScheduleViews,
  redactSecretAssignments,
  runScheduleNow,
  scheduleRunStatusLabel,
  scheduleTriggerLabel,
  truncateScheduleName,
  truncateSchedulePrompt,
  truncateText,
  unwrapSchedule,
  unwrapScheduleList,
  unwrapScheduleRuns,
  updateSchedule,
  validateScheduleForm,
  type ScheduleRunView,
  type ScheduleView,
} from "../workspace/schedules.js";

const CENTER = path.resolve(__dirname, "../components/workspace/surfaces/ScheduleCenter.tsx");
const TASK_SURFACES = path.resolve(__dirname, "../components/workspace/surfaces/TaskSurfaces.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const SIDEBAR = path.resolve(__dirname, "../components/workspace/WorkspaceSidebar.tsx");
const BRIDGE = path.resolve(__dirname, "../workspace/schedules.ts");
const TYPES = path.resolve(__dirname, "../workspace/types.ts");
const SURFACES = path.resolve(__dirname, "../workspace/surfaces.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function makeView(overrides: Partial<ScheduleView> & { scheduleId: string }): ScheduleView {
  return {
    projectId: "proj-A",
    name: "Nightly summary",
    prompt: "Summarize what changed today and report blockers.",
    enabled: true,
    timezone: "UTC",
    schedule: { kind: "interval", intervalMs: 3_600_000 },
    overlap: "skip",
    missedPolicy: "skip",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:05:00.000Z",
    nextRunAt: "2026-09-18T11:00:00.000Z",
    lastRunAt: "2026-09-18T09:00:00.000Z",
    lastRunStatus: "completed",
    ...overrides,
  };
}

function makeRun(overrides: Partial<ScheduleRunView> & { runId: string }): ScheduleRunView {
  return {
    scheduleId: "01SCHED0001",
    projectId: "proj-A",
    status: "completed",
    trigger: "scheduled",
    createdAt: "2026-09-18T09:00:00.000Z",
    startedAt: "2026-09-18T09:00:00.000Z",
    finishedAt: "2026-09-18T09:02:00.000Z",
    ...overrides,
  };
}

describe("renderer: schedule vocabulary (PR44)", () => {
  it("exposes once/delay/interval/daily/weekly kinds with no cron", () => {
    expect([...SCHEDULE_KINDS].sort()).toEqual(["daily", "delay", "interval", "once", "weekly"]);
    expect(SCHEDULE_KINDS as readonly string[]).not.toContain("cron");
    expect(OVERLAP_POLICIES).toContain("skip");
    expect(OVERLAP_POLICIES).toContain("queue_one");
    expect(MISSED_POLICIES).toContain("skip");
    expect(MISSED_POLICIES).toContain("run_once");
    expect([...SCHEDULE_RUN_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "pending",
      "running",
      "skipped",
    ]);
    expect(SCHEDULE_RUN_TRIGGERS).toEqual(["scheduled", "manual", "recovery"]);
  });

  it("labels triggers Scheduled/Manual/Recovered", () => {
    expect(scheduleTriggerLabel("scheduled")).toBe("Scheduled");
    expect(scheduleTriggerLabel("manual")).toBe("Manual");
    expect(scheduleTriggerLabel("recovery")).toBe("Recovered");
    expect(scheduleRunStatusLabel("skipped")).toBe("Skipped");
    expect(scheduleRunStatusLabel("pending")).toBe("Pending");
  });

  it("describes schedules without inventing cron", () => {
    expect(describeSchedule({ schedule: { kind: "interval", intervalMs: 300_000 } })).toBe(
      "Every 5m",
    );
    expect(describeSchedule({ schedule: { kind: "daily", dailyTime: "09:00" } })).toBe(
      "Daily at 09:00",
    );
    expect(
      describeSchedule({ schedule: { kind: "once", runAt: "2026-09-19T09:00:00.000Z" } }),
    ).toContain("Once at");
    expect(describeSchedule({ schedule: { kind: "delay", delayMs: 300_000 } })).toBe("After 5m");
    expect(describeSchedule({ schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 } })).toBe(
      "Weekly Mon 09:00",
    );
    // No cron kind or cron UI option: one-shot, delayed, interval, daily, weekly only.
    expect(SCHEDULE_KINDS as readonly string[]).not.toContain("cron");
    expect(read(CENTER)).not.toContain('value="cron"');
  });
});

describe("renderer: schedule projection normalization (PR44)", () => {
  it("accepts IPC envelopes and raw payloads", () => {
    const view = makeView({ scheduleId: "01S1" });
    expect(
      normalizeScheduleViews(unwrapScheduleList({ ok: true, value: { schedules: [view] } })),
    ).toHaveLength(1);
    expect(normalizeScheduleViews(unwrapScheduleList({ ok: true, value: [view] }))).toHaveLength(1);
    expect(normalizeScheduleViews(unwrapScheduleList([view]))).toHaveLength(1);
    expect(
      normalizeScheduleView(unwrapSchedule({ ok: true, value: { schedule: view } })),
    ).toMatchObject({ scheduleId: "01S1" });
    expect(unwrapScheduleList({ ok: false })).toEqual([]);
    expect(unwrapScheduleList(null)).toEqual([]);
  });

  it("accepts sibling spelling variants without a renderer change", () => {
    const variant = {
      id: "01S9",
      projectId: "proj-A",
      title: "Variant name",
      description: "Variant prompt",
      enabled: true,
      timeZone: "America/New_York",
      schedule: { kind: "interval", intervalMs: 600_000 },
      createdAt: "2026-09-18T10:00:00.000Z",
      updatedAt: "2026-09-18T10:00:00.000Z",
    };
    const view = normalizeScheduleView(variant);
    expect(view?.scheduleId).toBe("01S9");
    expect(view?.name).toBe("Variant name");
    expect(view?.timezone).toBe("America/New_York");
  });

  it("rejects malformed entries and sub-minute intervals", () => {
    const base = makeView({ scheduleId: "01S1" });
    expect(normalizeScheduleView({ ...base, scheduleId: "" })).toBeNull();
    expect(normalizeScheduleView({ ...base, projectId: "" })).toBeNull();
    expect(normalizeScheduleView({ ...base, name: "" })).toBeNull();
    expect(
      normalizeScheduleView({ ...base, schedule: { kind: "interval", intervalMs: 30_000 } }),
    ).toBeNull();
    expect(
      normalizeScheduleView({ ...base, schedule: { kind: "cron", expr: "* * *" } }),
    ).toBeNull();
    expect(normalizeScheduleView(null)).toBeNull();
    expect(normalizeScheduleView("schedule")).toBeNull();
  });

  it("defaults overlap/missed policies to skip", () => {
    const { overlap: _o, missedPolicy: _m, ...rest } = makeView({ scheduleId: "01S2" });
    void _o;
    void _m;
    const view = normalizeScheduleView(rest);
    expect(view?.overlap).toBe("skip");
    expect(view?.missedPolicy).toBe("skip");
  });

  it("normalizes run history with trigger defaults", () => {
    const run = makeRun({ runId: "01R1" });
    expect(
      normalizeScheduleRunViews(unwrapScheduleRuns({ ok: true, value: { runs: [run] } })),
    ).toHaveLength(1);
    expect(normalizeScheduleRunViews(unwrapScheduleRuns([run]))).toHaveLength(1);
    expect(unwrapScheduleRuns({ ok: false })).toEqual([]);
    const { trigger: _t, ...noTrigger } = run;
    void _t;
    expect(normalizeScheduleRunView(noTrigger)?.trigger).toBe("scheduled");
    expect(normalizeScheduleRunView({ ...run, status: "bogus" })).toBeNull();
    expect(normalizeScheduleRunView({ ...run, runId: "" })).toBeNull();
  });
});

describe("renderer: enabled vs disabled grouping (PR44)", () => {
  it("splits sections and orders enabled by next run", () => {
    const schedules = [
      makeView({ scheduleId: "01D1", enabled: false }),
      makeView({
        scheduleId: "01E2",
        enabled: true,
        nextRunAt: "2026-09-18T12:00:00.000Z",
      }),
      makeView({
        scheduleId: "01E1",
        enabled: true,
        nextRunAt: "2026-09-18T11:00:00.000Z",
      }),
    ];
    const grouped = groupSchedules(schedules);
    expect(grouped.enabled.map((s) => s.scheduleId)).toEqual(["01E1", "01E2"]);
    expect(grouped.disabled.map((s) => s.scheduleId)).toEqual(["01D1"]);
    expect(countEnabledSchedules(schedules)).toBe(2);
  });
});

describe("renderer: schedule form validation (PR44)", () => {
  const valid = {
    name: "Nightly summary",
    projectId: "proj-A",
    prompt: "Summarize the day.",
    kind: "interval",
    intervalMs: 3_600_000,
    timezone: "UTC",
    overlap: "skip",
    missedPolicy: "skip",
    enabled: true,
  };

  it("accepts a complete form", () => {
    expect(validateScheduleForm(valid)).toEqual({});
    expect(isScheduleFormValid(valid)).toBe(true);
  });

  it("rejects empty name/project/prompt with bounds", () => {
    expect(validateScheduleForm({ ...valid, name: "  " })).toHaveProperty("name");
    expect(validateScheduleForm({ ...valid, name: "x".repeat(121) })).toHaveProperty("name");
    expect(validateScheduleForm({ ...valid, projectId: "" })).toHaveProperty("projectId");
    expect(validateScheduleForm({ ...valid, prompt: "" })).toHaveProperty("prompt");
    expect(validateScheduleForm({ ...valid, prompt: "x".repeat(4001) })).toHaveProperty("prompt");
    expect(isScheduleFormValid({ ...valid, prompt: "" })).toBe(false);
  });

  it("rejects bad kind configs, timezones, and policies", () => {
    expect(validateScheduleForm({ ...valid, kind: "cron" })).toHaveProperty("kind");
    expect(validateScheduleForm({ ...valid, intervalMs: 30_000 })).toHaveProperty("intervalMs");
    expect(validateScheduleForm({ ...valid, kind: "once", runAt: "not-a-date" })).toHaveProperty(
      "runAt",
    );
    expect(validateScheduleForm({ ...valid, kind: "daily", dailyTime: "25:00" })).toHaveProperty(
      "dailyTime",
    );
    expect(validateScheduleForm({ ...valid, timezone: "Mars/Olympus" })).toHaveProperty("timezone");
    expect(validateScheduleForm({ ...valid, overlap: "parallel" })).toHaveProperty("overlap");
    expect(validateScheduleForm({ ...valid, missedPolicy: "retry-forever" })).toHaveProperty(
      "missedPolicy",
    );
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("nope")).toBe(false);
  });

  it("never validates a partial form as executable", () => {
    // Every required field missing at once still yields errors (no silent pass).
    const partial = {
      name: "",
      projectId: "",
      prompt: "",
      kind: "interval",
      timezone: "",
      overlap: "skip",
      missedPolicy: "skip",
      enabled: true,
    };
    const errors = validateScheduleForm(partial);
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    expect(isScheduleFormValid(partial)).toBe(false);
  });
});

describe("renderer: project isolation display (PR44)", () => {
  it("filters by bound projectId without rewriting it", () => {
    const schedules = [
      makeView({ scheduleId: "01A1", projectId: "proj-A" }),
      makeView({ scheduleId: "01B1", projectId: "proj-B" }),
    ];
    const scoped = filterSchedulesByProject(schedules, "proj-A");
    expect(scoped.map((s) => s.scheduleId)).toEqual(["01A1"]);
    expect(scoped[0]?.projectId).toBe("proj-A");
    expect(schedules[1]?.projectId).toBe("proj-B");
    expect(filterSchedulesByProject(schedules, "proj-C")).toEqual([]);
  });
});

describe("renderer: disconnect-requery through the local stub (PR44)", () => {
  it("returns null bridge without window and empty lists without commands", async () => {
    expect(getScheduleCommands()).toBeNull();
    await expect(fetchScheduleList(null, "proj-A")).resolves.toEqual([]);
    await expect(fetchSchedule(null, "01S1", "proj-A")).resolves.toBeNull();
    await expect(fetchScheduleRuns(null, "01S1", "proj-A")).resolves.toEqual([]);
    await expect(
      createSchedule(null, {
        name: "n",
        projectId: "p",
        prompt: "q",
        kind: "interval",
        intervalMs: 60_000,
        timezone: "UTC",
        overlap: "skip",
        missedPolicy: "skip",
        enabled: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(updateSchedule(null, "01S1", "proj-A", {})).resolves.toMatchObject({ ok: false });
    await expect(enableSchedule(null, "01S1", "proj-A")).resolves.toMatchObject({ ok: false });
    await expect(disableSchedule(null, "01S1", "proj-A")).resolves.toMatchObject({ ok: false });
    await expect(deleteSchedule(null, "01S1", "proj-A")).resolves.toMatchObject({ ok: false });
    await expect(runScheduleNow(null, "01S1", "proj-A")).resolves.toMatchObject({ ok: false });
  });

  it("re-queries stub state after remount/disconnect (no renderer truth)", async () => {
    const stub = createLocalScheduleStub([
      { scheduleId: "01S1", projectId: "proj-A", enabled: true },
    ]);
    const first = await fetchScheduleList(stub, "proj-A");
    expect(first.map((s) => s.scheduleId)).toEqual(["01S1"]);
    await expect(disableSchedule(stub, "01S1", "proj-A")).resolves.toMatchObject({ ok: true });
    const second = await fetchScheduleList(stub, "proj-A");
    expect(second[0]?.enabled).toBe(false);
    await expect(enableSchedule(stub, "01S1", "proj-A")).resolves.toMatchObject({ ok: true });
    expect((await fetchSchedule(stub, "01S1", "proj-A"))?.enabled).toBe(true);
    await expect(fetchSchedule(stub, "01NOPE", "proj-A")).resolves.toBeNull();
  });

  it("validates on create and locks the project on update", async () => {
    const stub = createLocalScheduleStub();
    await expect(
      createSchedule(stub, {
        name: "",
        projectId: "proj-A",
        prompt: "work",
        kind: "interval",
        intervalMs: 60_000,
        timezone: "UTC",
        overlap: "skip",
        missedPolicy: "skip",
        enabled: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      createSchedule(stub, {
        name: "ok",
        projectId: "proj-A",
        prompt: "work",
        kind: "interval",
        intervalMs: 30_000,
        timezone: "UTC",
        overlap: "skip",
        missedPolicy: "skip",
        enabled: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      createSchedule(stub, {
        name: "Nightly",
        projectId: "proj-A",
        prompt: "Do work.",
        kind: "interval",
        intervalMs: 3_600_000,
        timezone: "UTC",
        overlap: "skip",
        missedPolicy: "skip",
        enabled: true,
      }),
    ).resolves.toMatchObject({ ok: true });
    const listed = await fetchScheduleList(stub, "proj-A");
    expect(listed).toHaveLength(1);
    const id = listed[0]?.scheduleId ?? "";
    // Project is locked: update carries the bound projectId and cannot re-scope.
    await expect(updateSchedule(stub, id, "proj-A", { name: "Renamed" })).resolves.toMatchObject({
      ok: true,
    });
    expect((await fetchSchedule(stub, id, "proj-A"))?.projectId).toBe("proj-A");
    expect((await fetchSchedule(stub, id, "proj-A"))?.name).toBe("Renamed");
    // Cross-project reads/writes fail closed.
    await expect(fetchSchedule(stub, id, "proj-B")).resolves.toBeNull();
    await expect(updateSchedule(stub, id, "proj-B", { name: "Hijacked" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("labels manual runs and keeps run history after delete (delete≠cancel)", async () => {
    const stub = createLocalScheduleStub([{ scheduleId: "01S2", projectId: "proj-A" }]);
    await expect(runScheduleNow(stub, "01S2", "proj-A")).resolves.toMatchObject({ ok: true });
    const runs = await fetchScheduleRuns(stub, "01S2", "proj-A");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("manual");
    expect(scheduleTriggerLabel(runs[0]?.trigger ?? "scheduled")).toBe("Manual");
    await expect(deleteSchedule(stub, "01S2", "proj-A")).resolves.toMatchObject({ ok: true });
    expect(await fetchSchedule(stub, "01S2", "proj-A")).toBeNull();
    // Run history survives the definition delete; running tasks keep their
    // own lifecycle behind the background-task bridge (delete≠cancel).
    expect(await fetchScheduleRuns(stub, "01S2", "proj-A")).toHaveLength(1);
  });

  it("seeds canonical runs and maps the legacy recovered trigger", async () => {
    const stub = createLocalScheduleStub([{ scheduleId: "01S3", projectId: "proj-A" }]);
    stub.seedRun({
      runId: "01R9",
      scheduleId: "01S3",
      projectId: "proj-A",
      status: "running",
      trigger: "scheduled",
      startedAt: "2026-09-18T09:00:00.000Z",
    });
    const runs = await fetchScheduleRuns(stub, "01S3", "proj-A");
    expect(runs[0]?.status).toBe("running");
    // Legacy trigger spelling still normalizes to canonical recovery.
    expect(normalizeScheduleRunView({ ...runs[0], trigger: "recovered" })?.trigger).toBe(
      "recovery",
    );
    expect(scheduleTriggerLabel("recovery")).toBe("Recovered");
  });
});

describe("renderer: hygiene — truncation and secret redaction (PR44)", () => {
  it("bounds names (120) and prompts (4000) at render", () => {
    expect(MAX_SCHEDULE_DISPLAY_NAME).toBe(120);
    expect(MAX_SCHEDULE_DISPLAY_PROMPT).toBe(4000);
    expect(truncateScheduleName("x".repeat(200))).toHaveLength(121);
    expect(truncateSchedulePrompt("x".repeat(5000))).toHaveLength(4001);
    expect(truncateText("short", 120)).toBe("short");
  });

  it("redacts assignment-shaped secrets but keeps plain prose", () => {
    expect(redactSecretAssignments("api_key=sk-live-12345")).toBe("api_key: [redacted]");
    expect(redactSecretAssignments("Authorization: Bearer abc.def")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactSecretAssignments("password: hunter2 failed")).toBe("password: [redacted] failed");
    expect(redactSecretAssignments("token limit exceeded, retry later")).toBe(
      "token limit exceeded, retry later",
    );
  });

  it("formats countdowns and durations safely without throwing", () => {
    expect(formatNextRunCountdown(undefined)).toBe("—");
    expect(formatNextRunCountdown("not-a-date")).toBe("—");
    const base = Date.parse("2026-09-18T10:00:00.000Z");
    expect(formatNextRunCountdown("2026-09-18T10:05:00.000Z", base)).toBe("in 5m 0s");
    expect(formatNextRunCountdown("2026-09-18T09:55:00.000Z", base)).toContain("overdue by");
    expect(
      formatScheduleRunDuration(
        makeRun({
          runId: "01D1",
          startedAt: "2026-09-18T10:00:00.000Z",
          finishedAt: "2026-09-18T10:03:12.000Z",
        }),
      ),
    ).toBe("3m 12s");
    expect(formatScheduleRunDuration(makeRun({ runId: "01D2", startedAt: undefined }))).toBe("—");
  });
});

describe("renderer: caps (PR44)", () => {
  it("pins the 32/8/1min/50/1-catch-up budgets", () => {
    expect(MAX_SCHEDULES_TOTAL).toBe(32);
    expect(MAX_CONCURRENT_SCHEDULE_RUNS).toBe(8);
    expect(MIN_SCHEDULE_INTERVAL_MS).toBe(60_000);
    expect(MAX_SCHEDULE_ROWS_PER_SECTION).toBe(50);
    expect(MAX_SCHEDULE_RUNS_SHOWN).toBe(50);
    expect(MAX_SCHEDULE_CATCH_UP).toBe(1);
  });
});

describe("Schedule Center contract (PR44)", () => {
  it("extends props with the schedule center contract", () => {
    const props = read(PROPS);
    expect(props).toContain("ScheduleCenterProps");
    expect(props).toContain("pendingPermissions?");
    expect(props).toContain("onResolvePermission?");
    expect(props).toContain("taskActivity?");
    expect(props).toContain("schedules?: ScheduleCenterProps");
    expect(props).toContain("schedulesEnabledCount?");
  });

  it("renders Enabled/Disabled sections with the required row fields", () => {
    const component = read(CENTER);
    expect(component).toContain("Schedules");
    expect(component).toContain("Enabled");
    expect(component).toContain("Disabled");
    expect(component).toContain("Next run");
    expect(component).toContain("Last run");
    expect(component).toContain("Status");
    expect(component).toContain("project:");
  });

  it("shows the required detail fields", () => {
    const component = read(CENTER);
    expect(component).toContain("Prompt");
    expect(component).toContain("Project");
    expect(component).toContain("Timezone");
    expect(component).toContain("Previous run");
    expect(component).toContain("Overlap policy");
    expect(component).toContain("Missed-run policy");
    expect(component).toContain("scheduleTriggerLabel");
    expect(component).toContain("describeSchedule");
  });

  it("gates the create/edit form on full validation (no execute on partial form)", () => {
    const component = read(CENTER);
    expect(component).toContain("validateScheduleForm");
    expect(component).toContain("isScheduleFormValid");
    expect(component).toContain("nothing executes from a partial form");
    expect(component).toContain("Schedule name");
    expect(component).toContain("Schedule project");
    expect(component).toContain("Schedule prompt");
    expect(component).toContain("Schedule kind");
    expect(component).toContain("Schedule timezone");
    expect(component).toContain("Schedule overlap policy");
    expect(component).toContain("Schedule missed-run policy");
    expect(component).toContain("locked per schedule");
  });

  it("offers Run now + Enable/Disable + Delete with delete≠cancel messaging", () => {
    const component = read(CENTER);
    expect(component).toContain("Run now");
    expect(component).toContain("Disable");
    expect(component).toContain("Enable");
    expect(component).toContain("Delete");
    expect(component).toContain("does not cancel");
  });

  it("renders run history with trigger labels", () => {
    const component = read(CENTER);
    expect(component).toContain("Run history");
    expect(component).toContain("started");
    expect(component).toContain("finished");
    expect(component).toContain("Manual");
  });

  it("routes run approval through the existing permission path and never auto-approves", () => {
    const component = read(CENTER);
    expect(component).toContain("Schedule run requires approval");
    expect(component).toContain("onResolvePermission");
    expect(component).toContain("never");
    expect(component).toContain("auto-approv");
    expect(component).not.toMatch(/autoApprov\s*=\s*true/);
    expect(component).not.toMatch(/approveAutomatically/);
  });

  it("re-queries on mount and polls once without renderer-local truth", () => {
    const component = read(CENTER);
    expect(component).toContain("getScheduleCommands");
    expect(component).toContain("createLocalScheduleStub");
    expect(component).toContain("setInterval");
    expect(component).toContain("clearInterval");
    expect(component).toContain("re-queries");
    // Single bounded poll: exactly one setInterval in the surface.
    expect(component.match(/setInterval/g)?.length).toBe(1);
  });

  it("derives the timeline from existing activity projections only", () => {
    const component = read(CENTER);
    expect(component).toContain("taskActivity");
    expect(component).toContain('kind === "task"');
    expect(component).not.toMatch(/notificationBus|NotificationBus|subscribeToSchedules/);
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
    expect(read(CENTER)).not.toMatch(/window\.api\.schedules\.[a-z]+\(/);
  });

  it("exposes the narrow schedules bridge with the expected methods", () => {
    const bridge = read(BRIDGE);
    for (const method of [
      "list",
      "get",
      "create",
      "update",
      "enable",
      "disable",
      "delete",
      "runNow",
      "runs",
    ]) {
      expect(bridge).toContain(method);
    }
    expect(bridge).toContain("window.api");
    expect(bridge).toContain("schedules");
    expect(bridge).toContain("?.");
    expect(read(SURFACES)).toContain("schedules.js");
  });

  it("extends the Tasks surface into a Schedule Center without replacing it", () => {
    const tasks = read(TASK_SURFACES);
    expect(tasks).toContain("ScheduleCenter");
    expect(tasks).toContain("BackgroundTaskCenter");
    expect(tasks).toContain("agentTasks");
  });

  it("shows enabled schedules on the Tasks sidebar entry", () => {
    const sidebar = read(SIDEBAR);
    expect(sidebar).toContain("schedulesEnabledCount");
  });

  it("registers the Schedule Center on the existing tasks surface", () => {
    const types = read(TYPES);
    expect(types).toContain("SCHEDULE_CENTER_SURFACE");
    expect(types).not.toContain('"schedule-center"');
  });
});
