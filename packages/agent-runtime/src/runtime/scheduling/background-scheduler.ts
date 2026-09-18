// PR44: packages/agent-runtime — BackgroundScheduler (CORE thin orchestration)
//
// Thin orchestration over injected ports: a ScheduleStorePort (durable
// schedules + runs), a BackgroundTaskLauncher (structural match for
// BackgroundTaskManager.start — adapted by the desktop layer as
// `(i) => manager.start(i).then(r => "error" in r ? r : { backgroundTaskId:
// r.record.taskId })`, so this file imports NO manager and creates NO cycle),
// and an optional EventSink.
//
// Single timer only (SCHEDULER_TICK_MS_DEFAULT 30_000, injectable clock + tick
// interval for tests; no per-task timers). Each tick loads enabled schedules,
// recomputes due occurrences from anchor timestamps via the pure calculator
// (a stale persisted nextRunAt is never trusted blindly), applies
// missed/overlap policies, and launches at most one run per schedule through
// the launcher. The scheduler never calls tools, shell, fs, or network.
//
// Exactly-once strategy:
//   - A durable run record (pending) is created BEFORE the launcher is
//     invoked. Launch failure marks the run failed; the scheduler performs no
//     retry (execution retry belongs to Agent Runtime PR29 semantics).
//   - A crash between record creation and launch leaves a pending run with no
//     backgroundTaskId; the next tick ADOPTS it (launches that same run, no
//     duplicate record) instead of creating a second one.
//   - Handling a due batch advances lastRunAt/nextRunAt, so a re-tick finds
//     nothing new (no-duplicate-run on double tick).
//   - Startup recover() validates, secret-checks, dedupes, rebuilds the runId
//     ledger + active/parked maps, and recomputes a sane (policy-aware)
//     nextRunAt pointer. It never launches and never mutates
//     missedCount/lastRunAt/runCount: all missed accounting happens exactly
//     once in tick() from anchor timestamps. Re-running recover() with the
//     same input performs no further writes (runId ledger + schedule version
//     check via updatedAt/pointer equality).
//
// Overlap handling needs a settle signal the polling tick cannot observe, so
// the desktop layer calls settleRun() when a launched background task reaches
// a terminal state (wired from BackgroundTaskManager outcomes). settleRun()
// clears the active slot, emits schedule.run.completed/failed, and launches a
// parked queue_one run if one exists.
//
// Security / permissions:
//   - Fail-closed secret guard on name/prompt/description at runNow() and at
//     tick-launch time (secret-refused; a tripped schedule is disabled, never
//     launched with the payload).
//   - projectId is immutable per schedule; cross-project ops are
//     project-mismatch; malformed ids are validation-error; unknown ids are
//     not-found. Error/detail text is truncated to ai-core bounds.
//   - The scheduler auto-approves NOTHING: launched tasks flow through
//     BackgroundTaskManager -> PermissionManager and may park in
//     waiting_permission. Schedule existence is never a permission grant.
//
// Zero Electron, Prisma, child process spawn, fs, or network imports.

import {
  assertNoSecrets,
  createEventId,
  createScheduledRunId,
  MAX_CATCH_UP_RUNS,
  MAX_RUNS_PER_SCHEDULE,
  MAX_SCHEDULE_ERROR_LENGTH,
  ScheduledRunRecordSchema,
  ScheduledTaskRecordSchema,
  scheduleEventType,
  SCHEDULER_TICK_MS_DEFAULT,
  toScheduleError,
  type ScheduleError,
  type ScheduledRunId,
  type ScheduledRunRecord,
  type ScheduledTaskRecord,
  type ScheduleTrigger,
} from "@ai-desktop/ai-core";
import { createConversationId, isUlid, type ConversationId, type TaskId } from "@ai-desktop/shared";
import { countDueOccurrences, nextPointerAfterNow } from "./schedule-calculator.js";
import type { AIEvent } from "@ai-desktop/ai-core";
import type { EventSink } from "../types.js";

// ---------------------------------------------------------------------------
// Ports (structural; defined here to avoid cycles)
// ---------------------------------------------------------------------------

/** Durable schedule/run persistence owned by the desktop/storage layer. */
export interface ScheduleStorePort {
  loadEnabled(): Promise<ScheduledTaskRecord[]> | ScheduledTaskRecord[];
  getSchedule(
    scheduleId: string,
  ): Promise<ScheduledTaskRecord | undefined> | ScheduledTaskRecord | undefined;
  saveSchedule(schedule: ScheduledTaskRecord): Promise<void> | void;
  saveRun(run: ScheduledRunRecord): Promise<void> | void;
  listRuns(scheduleId: string): Promise<ScheduledRunRecord[]> | ScheduledRunRecord[];
  deleteRun(runId: string): Promise<void> | void;
  getActiveRunId(scheduleId: string): Promise<string | undefined> | string | undefined;
  setActiveRunId(scheduleId: string, runId: string | undefined): Promise<void> | void;
  getQueuedRunId(scheduleId: string): Promise<string | undefined> | string | undefined;
  setQueuedRunId(scheduleId: string, runId: string | undefined): Promise<void> | void;
}

export type LauncherOk = { readonly backgroundTaskId: TaskId };
export type LauncherErr = { readonly error: { readonly code: string; readonly message: string } };
export type LaunchOutcome = LauncherOk | LauncherErr;

/**
 * Structural match for BackgroundTaskManager.start (adapted by the caller).
 * Never throws for domain failures (returns { error }); a thrown exception
 * is treated as a launch failure, never retried by the scheduler.
 */
export interface BackgroundTaskLauncher {
  launch(input: {
    readonly projectId: string;
    readonly goal: string;
    readonly title?: string;
  }): Promise<LaunchOutcome>;
}

/** Event emission boundary (reuses the canonical runtime EventSink). */
export type ScheduleEventSink = EventSink;

// ---------------------------------------------------------------------------
// Options / Result Shapes
// ---------------------------------------------------------------------------

export interface BackgroundSchedulerOptions {
  readonly store: ScheduleStorePort;
  readonly launcher: BackgroundTaskLauncher;
  readonly eventSink?: ScheduleEventSink;
  readonly clock?: () => number;
  readonly tickMs?: number;
  readonly createRunId?: () => ScheduledRunId;
  /** Test-only calculator override (never from persisted data). */
  readonly minIntervalMs?: number;
  readonly maxRunsPerSchedule?: number;
}

export interface TickSummary {
  readonly launched: number;
  readonly skipped: number;
  readonly queued: number;
  readonly failed: number;
}

export interface RecoverSummary {
  readonly validated: number;
  readonly rejected: number;
  readonly recomputed: number;
  readonly recoveredRuns: number;
}

export interface SchedulerRunOk {
  readonly run: ScheduledRunRecord;
}
export interface SchedulerScheduleOk {
  readonly schedule: ScheduledTaskRecord;
}
export interface SchedulerErr {
  readonly error: ScheduleError;
}
export type SchedulerRunResult = SchedulerRunOk | SchedulerErr;
export type SchedulerScheduleResult = SchedulerScheduleOk | SchedulerErr;

export function isSchedulerError(
  result: SchedulerRunResult | SchedulerScheduleResult | unknown,
): result is SchedulerErr {
  return typeof result === "object" && result !== null && "error" in result;
}

export type SettleOutcome = "completed" | "failed" | "cancelled";

// ---------------------------------------------------------------------------
// In-Memory Store (tests / single-process desktop wiring)
// ---------------------------------------------------------------------------

export class InMemoryScheduleStore implements ScheduleStorePort {
  private readonly _schedules = new Map<string, ScheduledTaskRecord>();
  private readonly _runs = new Map<string, ScheduledRunRecord>();
  private readonly _active = new Map<string, string>();
  private readonly _parked = new Map<string, string>();
  scheduleSaves = 0;
  runSaves = 0;

  addSchedule(record: ScheduledTaskRecord): void {
    this._schedules.set(record.id as string, { ...record });
  }

  addRun(run: ScheduledRunRecord): void {
    this._runs.set(run.runId as string, { ...run });
  }

  getAllSchedules(): ScheduledTaskRecord[] {
    return [...this._schedules.values()].map((s) => ({ ...s }));
  }

  getAllRuns(): ScheduledRunRecord[] {
    return [...this._runs.values()].map((r) => ({ ...r }));
  }

  activeFor(scheduleId: string): string | undefined {
    return this._active.get(scheduleId);
  }

  parkedFor(scheduleId: string): string | undefined {
    return this._parked.get(scheduleId);
  }

  loadEnabled(): ScheduledTaskRecord[] {
    return [...this._schedules.values()].filter((s) => s.enabled).map((s) => ({ ...s }));
  }

  getSchedule(scheduleId: string): ScheduledTaskRecord | undefined {
    const found = this._schedules.get(scheduleId);
    return found ? { ...found } : undefined;
  }

  saveSchedule(schedule: ScheduledTaskRecord): void {
    this.scheduleSaves += 1;
    this._schedules.set(schedule.id as string, { ...schedule });
  }

  saveRun(run: ScheduledRunRecord): void {
    this.runSaves += 1;
    this._runs.set(run.runId as string, { ...run });
  }

  listRuns(scheduleId: string): ScheduledRunRecord[] {
    return [...this._runs.values()]
      .filter((r) => (r.scheduleId as string) === scheduleId)
      .map((r) => ({ ...r }));
  }

  deleteRun(runId: string): void {
    this._runs.delete(runId);
  }

  getActiveRunId(scheduleId: string): string | undefined {
    return this._active.get(scheduleId);
  }

  setActiveRunId(scheduleId: string, runId: string | undefined): void {
    if (runId === undefined) this._active.delete(scheduleId);
    else this._active.set(scheduleId, runId);
  }

  getQueuedRunId(scheduleId: string): string | undefined {
    return this._parked.get(scheduleId);
  }

  setQueuedRunId(scheduleId: string, runId: string | undefined): void {
    if (runId === undefined) this._parked.delete(scheduleId);
    else this._parked.set(scheduleId, runId);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const DANGEROUS_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function toIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function validateId(value: unknown, label: string): { id: string } | SchedulerErr {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return { error: toScheduleError("validation-error", `Invalid ${label}`) };
  }
  if (DANGEROUS_IDS.has(value)) {
    return { error: toScheduleError("validation-error", `Invalid ${label}`) };
  }
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    return { error: toScheduleError("validation-error", `Invalid ${label}`) };
  }
  if (!isUlid(value)) {
    return { error: toScheduleError("validation-error", `Invalid ${label}`) };
  }
  return { id: value };
}

function validateProjectId(projectId: unknown): { projectId: string } | SchedulerErr {
  if (typeof projectId !== "string" || projectId.trim().length === 0 || projectId.length > 256) {
    return { error: toScheduleError("validation-error", "Invalid projectId") };
  }
  if (DANGEROUS_IDS.has(projectId)) {
    return { error: toScheduleError("validation-error", "Invalid projectId") };
  }
  return { projectId };
}

function checkSecrets(schedule: ScheduledTaskRecord): boolean {
  try {
    assertNoSecrets(schedule.prompt);
    assertNoSecrets(schedule.name);
    if (schedule.description !== undefined) assertNoSecrets(schedule.description);
    return true;
  } catch {
    return false;
  }
}

export class BackgroundScheduler {
  private readonly _store: ScheduleStorePort;
  private readonly _launcher: BackgroundTaskLauncher;
  private readonly _eventSink?: ScheduleEventSink;
  private readonly _clock: () => number;
  private readonly _tickMs: number;
  private readonly _createRunId: () => ScheduledRunId;
  private readonly _minIntervalMs: number | undefined;
  private readonly _maxRuns: number;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _sequence = 0;
  private readonly _conversations = new Map<string, ConversationId>();
  private readonly _activeRuns = new Map<string, string>();
  private readonly _parkedRuns = new Map<string, string>();
  private readonly _knownRunIds = new Set<string>();
  private readonly _recoveredSigs = new Set<string>();

  constructor(options: BackgroundSchedulerOptions) {
    if (!options || !options.store) {
      throw new TypeError("BackgroundScheduler requires a store port");
    }
    if (!options.launcher) {
      throw new TypeError("BackgroundScheduler requires a launcher port");
    }
    this._store = options.store;
    this._launcher = options.launcher;
    this._eventSink = options.eventSink;
    this._clock = options.clock ?? Date.now;
    this._tickMs = options.tickMs ?? SCHEDULER_TICK_MS_DEFAULT;
    this._createRunId = options.createRunId ?? createScheduledRunId;
    this._minIntervalMs = options.minIntervalMs;
    this._maxRuns = options.maxRunsPerSchedule ?? MAX_RUNS_PER_SCHEDULE;
  }

  get isRunning(): boolean {
    return this._timer !== undefined;
  }

  get tickMs(): number {
    return this._tickMs;
  }

  /** Starts the single polling timer. Idempotent: a second start() is a no-op. */
  start(): void {
    if (this._timer !== undefined) return;
    this._timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this._tickMs);
    const maybeUnref = this._timer as unknown as { unref?: unknown };
    if (typeof maybeUnref.unref === "function") {
      (maybeUnref as { unref(): void }).unref();
    }
  }

  /** Stops the polling timer. Idempotent. Never touches active runs. */
  stop(): void {
    if (this._timer === undefined) return;
    clearInterval(this._timer);
    this._timer = undefined;
  }

  // -------------------------------------------------------------------------
  // tick(): at most one launch per schedule; summary counts policy outcomes.
  // -------------------------------------------------------------------------

  async tick(nowMs?: number): Promise<TickSummary> {
    const now = nowMs ?? this._clock();
    const summary = { launched: 0, skipped: 0, queued: 0, failed: 0 };
    let schedules: ScheduledTaskRecord[];
    try {
      schedules = await this._store.loadEnabled();
    } catch {
      return { ...summary };
    }
    for (const raw of schedules) {
      const parsed = ScheduledTaskRecordSchema.safeParse(raw);
      // Invalid records are recovery's job to report; tick never executes them.
      if (!parsed.success) continue;
      if (!parsed.data.enabled) continue;
      try {
        await this._tickOne(parsed.data, now, summary);
      } catch {
        // One bad schedule never breaks the rest of the tick.
      }
    }
    return { ...summary };
  }

  private async _tickOne(
    schedule: ScheduledTaskRecord,
    now: number,
    summary: { launched: number; skipped: number; queued: number; failed: number },
  ): Promise<void> {
    // Fail-closed secret guard: never launch a secret-bearing payload; park
    // the schedule disabled instead of hot-looping on it.
    if (!checkSecrets(schedule)) {
      const nowIso = toIso(now);
      const run = this._newRun(schedule, "scheduled", toIso(now));
      run.status = "failed";
      run.startedAt = nowIso;
      run.finishedAt = nowIso;
      run.error = "secret-refused: schedule text appears to contain secret material";
      await this._store.saveRun({ ...run });
      const disabled: ScheduledTaskRecord = {
        ...schedule,
        enabled: false,
        updatedAt: nowIso,
        lastRunStatus: "failed",
      };
      await this._store.saveSchedule(disabled);
      await this._emit(schedule, scheduleEventType("run.failed"), {
        runId: run.runId,
        status: "failed",
        detail: run.error,
      });
      await this._emit(schedule, scheduleEventType("disabled"), {
        detail: "Schedule disabled fail-closed: secret material detected.",
      });
      summary.failed += 1;
      return;
    }

    const createdAtMs = Date.parse(schedule.createdAt);
    const lastRunMs = schedule.lastRunAt !== undefined ? Date.parse(schedule.lastRunAt) : undefined;
    const isOneShot = schedule.kind === "once" || schedule.kind === "delay";
    const consumed = isOneShot && lastRunMs !== undefined && Number.isFinite(lastRunMs);
    if (consumed) {
      // A fired one-shot that is somehow still enabled is consumed: disable it.
      const disabled: ScheduledTaskRecord = {
        ...schedule,
        enabled: false,
        updatedAt: toIso(now),
      };
      await this._store.saveSchedule(disabled);
      await this._emit(schedule, scheduleEventType("disabled"), {
        detail: "One-shot schedule consumed; auto-disabled.",
      });
      return;
    }
    let anchorMs = lastRunMs !== undefined && Number.isFinite(lastRunMs) ? lastRunMs : createdAtMs;
    if (!Number.isFinite(anchorMs)) return;
    // A once schedule created with an already-past runAt is still due exactly
    // once under run_once: pull the exclusive anchor just before the fire time.
    if (schedule.kind === "once" && !consumed) {
      const fireMs = Date.parse((schedule.config as { runAt: string }).runAt);
      if (Number.isFinite(fireMs)) anchorMs = Math.min(anchorMs, fireMs - 1);
    }

    let due;
    try {
      due = countDueOccurrences(
        {
          kind: schedule.kind,
          config: schedule.config,
          timezone: schedule.timezone,
          createdAtMs,
          anchorMs,
          nowMs: now,
          consumed,
        },
        this._calcOptions(),
      );
    } catch {
      return;
    }

    if (due.count < 1 || due.earliestMs === undefined || due.latestMs === undefined) {
      await this._fixPointer(schedule, anchorMs, consumed, now);
      return;
    }

    // One-shot + skip + past-due: drop the occurrence, record it as skipped,
    // and auto-disable. ANY lateness drops (ticks are 30s apart, so a
    // one-shot explicitly configured with skip is a footgun by design); the
    // kind default run_once exists precisely so one-shots fire even when late.
    if (isOneShot && schedule.missedPolicy === "skip") {
      const nowIso = toIso(now);
      const fireIso = toIso(due.latestMs);
      const run = this._newRun(schedule, "scheduled", fireIso);
      run.status = "skipped";
      run.finishedAt = nowIso;
      await this._store.saveRun({ ...run });
      await this._pruneRuns(schedule.id as string);
      const updated: ScheduledTaskRecord = {
        ...schedule,
        enabled: false,
        updatedAt: nowIso,
        nextRunAt: fireIso,
        lastRunAt: fireIso,
        lastRunStatus: "skipped",
        missedCount: schedule.missedCount + 1,
      };
      await this._store.saveSchedule(updated);
      await this._emit(schedule, scheduleEventType("due"), {
        detail: `Schedule due at ${fireIso}; occurrence skipped (missedPolicy skip).`,
      });
      await this._emit(schedule, scheduleEventType("run.skipped"), {
        runId: run.runId,
        status: "skipped",
        detail: "One-shot occurrence past due; skipped and auto-disabled.",
      });
      await this._emit(schedule, scheduleEventType("disabled"), {
        detail: "One-shot schedule consumed; auto-disabled.",
      });
      summary.skipped += 1;
      return;
    }

    // Catch-up rule (decision 3): at most MAX_CATCH_UP_RUNS (1) run fires;
    // run_once fires the earliest due occurrence, skip fires the current
    // (latest) one; every other due occurrence collapses into missedCount.
    const scheduledForMs = schedule.missedPolicy === "run_once" ? due.earliestMs : due.latestMs;
    const excess = Math.max(0, due.count - MAX_CATCH_UP_RUNS);

    const activeRunId = await this._activeRunId(schedule.id as string);
    if (activeRunId !== undefined) {
      const activeRun = await this._findRun(schedule.id as string, activeRunId);
      // Crash-adoption: the pending run was durably recorded but the launcher
      // was never reached (or its outcome was lost). Launch THAT run instead
      // of creating a duplicate record.
      if (activeRun && activeRun.status === "pending" && activeRun.backgroundTaskId === undefined) {
        await this._launchRecordedRun(schedule, activeRun, now, summary, {
          scheduledForMs,
          excess,
          latestMs: due.latestMs,
        });
        return;
      }
      if (schedule.overlapPolicy === "skip") {
        const nowIso = toIso(now);
        const run = this._newRun(schedule, "scheduled", toIso(scheduledForMs));
        run.status = "skipped";
        run.finishedAt = nowIso;
        await this._store.saveRun({ ...run });
        await this._pruneRuns(schedule.id as string);
        const updated: ScheduledTaskRecord = {
          ...schedule,
          updatedAt: nowIso,
          nextRunAt: toIso(this._pointerAfter(schedule, createdAtMs, due.latestMs, now)),
          lastRunAt: toIso(due.latestMs),
          lastRunStatus: "skipped",
          missedCount: schedule.missedCount + excess,
        };
        await this._store.saveSchedule(updated);
        await this._emit(schedule, scheduleEventType("due"), {
          detail: `Schedule due at ${toIso(scheduledForMs)}; skipped (overlap).`,
        });
        await this._emit(schedule, scheduleEventType("run.skipped"), {
          runId: run.runId,
          status: "skipped",
          detail: "Previous run still active; occurrence skipped (overlapPolicy skip).",
        });
        summary.skipped += 1;
        return;
      }
      // overlapPolicy queue_one: park exactly one pending occurrence.
      const parkedId = await this._parkedRunId(schedule.id as string);
      if (parkedId === undefined) {
        const run = this._newRun(schedule, "scheduled", toIso(scheduledForMs));
        await this._store.saveRun({ ...run });
        await this._pruneRuns(schedule.id as string);
        this._parkedRuns.set(schedule.id as string, run.runId as string);
        await this._store.setQueuedRunId(schedule.id as string, run.runId as string);
        const updated: ScheduledTaskRecord = {
          ...schedule,
          updatedAt: toIso(now),
          nextRunAt: toIso(this._pointerAfter(schedule, createdAtMs, due.latestMs, now)),
          lastRunAt: toIso(due.latestMs),
          lastRunStatus: "pending",
          missedCount: schedule.missedCount + excess,
        };
        await this._store.saveSchedule(updated);
        await this._emit(schedule, scheduleEventType("due"), {
          detail: `Schedule due at ${toIso(scheduledForMs)}; parked (overlap).`,
        });
        summary.queued += 1;
        return;
      }
      // A second overlap while one is already parked collapses into missedCount.
      const updated: ScheduledTaskRecord = {
        ...schedule,
        updatedAt: toIso(now),
        nextRunAt: toIso(this._pointerAfter(schedule, createdAtMs, due.latestMs, now)),
        lastRunAt: toIso(due.latestMs),
        lastRunStatus: schedule.lastRunStatus,
        missedCount: schedule.missedCount + excess + 1,
      };
      await this._store.saveSchedule(updated);
      summary.skipped += 1;
      return;
    }

    // No active run: create the durable pending record first, then launch.
    const run = this._newRun(schedule, "scheduled", toIso(scheduledForMs));
    await this._launchRecordedRun(schedule, run, now, summary, {
      scheduledForMs,
      excess,
      latestMs: due.latestMs,
    });
  }

  // -------------------------------------------------------------------------
  // runNow(): explicit manual launch (still permission-aware downstream).
  // -------------------------------------------------------------------------

  async runNow(
    scheduleId: unknown,
    projectId: unknown,
    trigger: ScheduleTrigger = "manual",
  ): Promise<SchedulerRunResult> {
    const idCheck = validateId(scheduleId, "scheduleId");
    if (isSchedulerError(idCheck)) return idCheck;
    const projectCheck = validateProjectId(projectId);
    if (isSchedulerError(projectCheck)) return projectCheck;
    if (trigger !== "manual" && trigger !== "recovery" && trigger !== "scheduled") {
      return { error: toScheduleError("validation-error", "Invalid trigger") };
    }
    let stored: ScheduledTaskRecord | undefined;
    try {
      stored = await this._store.getSchedule(idCheck.id);
    } catch {
      return { error: toScheduleError("storage-error", "Schedule store unavailable") };
    }
    if (!stored) {
      return { error: toScheduleError("not-found", "Schedule not found") };
    }
    const parsed = ScheduledTaskRecordSchema.safeParse(stored);
    if (!parsed.success) {
      return { error: toScheduleError("validation-error", "Stored schedule is malformed") };
    }
    const schedule = parsed.data;
    if (schedule.projectId !== projectCheck.projectId) {
      return { error: toScheduleError("project-mismatch", "Schedule project mismatch") };
    }
    if (!checkSecrets(schedule)) {
      return {
        error: toScheduleError(
          "secret-refused",
          "secret-refused: schedule text appears to contain secret material",
        ),
      };
    }
    // Manual launches are allowed on disabled schedules (explicit user action);
    // they never move the periodic pointer (lastRunAt/nextRunAt untouched).
    const activeRunId = await this._activeRunId(schedule.id as string);
    if (activeRunId !== undefined) {
      if (schedule.overlapPolicy === "skip") {
        return {
          error: toScheduleError("task-active", "Schedule already has an active run"),
        };
      }
      const parkedId = await this._parkedRunId(schedule.id as string);
      if (parkedId !== undefined) {
        return {
          error: toScheduleError("task-active", "Schedule already has a parked run"),
        };
      }
      const nowIso = toIso(this._clock());
      const parked = this._newRun(schedule, trigger, nowIso);
      try {
        await this._store.saveRun({ ...parked });
      } catch {
        return { error: toScheduleError("storage-error", "Schedule store unavailable") };
      }
      await this._pruneRuns(schedule.id as string);
      this._parkedRuns.set(schedule.id as string, parked.runId as string);
      try {
        await this._store.setQueuedRunId(schedule.id as string, parked.runId as string);
      } catch {
        // Local map already tracks the parked run; persistence is best-effort.
      }
      return { run: { ...parked } };
    }
    const nowIso = toIso(this._clock());
    const run = this._newRun(schedule, trigger, nowIso);
    const launched = await this._launchNewRun(schedule, run);
    if (launched === "launched") {
      const updated: ScheduledTaskRecord = {
        ...schedule,
        updatedAt: nowIso,
        runCount: schedule.runCount + 1,
        lastRunStatus: "running",
      };
      try {
        await this._store.saveSchedule(updated);
      } catch {
        // Launch already happened; persistence failure must not fake an error.
      }
      return { run: this._lastLaunchedState(run.runId as string, run) };
    }
    return { run: this._lastLaunchedState(run.runId as string, run) };
  }

  // -------------------------------------------------------------------------
  // settleRun(): terminal signal from the desktop layer. Clears the active
  // slot, records the outcome, and launches a parked queue_one run if present.
  // -------------------------------------------------------------------------

  async settleRun(
    scheduleId: unknown,
    runId: unknown,
    outcome: SettleOutcome,
    options?: { readonly projectId?: string; readonly detail?: string },
  ): Promise<SchedulerRunResult> {
    const idCheck = validateId(scheduleId, "scheduleId");
    if (isSchedulerError(idCheck)) return idCheck;
    const runCheck = validateId(runId, "runId");
    if (isSchedulerError(runCheck)) return runCheck;
    if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") {
      return { error: toScheduleError("validation-error", "Invalid settle outcome") };
    }
    let schedule: ScheduledTaskRecord | undefined;
    let runs: ScheduledRunRecord[] = [];
    try {
      schedule = await this._store.getSchedule(idCheck.id);
      if (schedule) runs = await this._store.listRuns(idCheck.id);
    } catch {
      return { error: toScheduleError("storage-error", "Schedule store unavailable") };
    }
    if (!schedule) {
      return { error: toScheduleError("not-found", "Schedule not found") };
    }
    const parsed = ScheduledTaskRecordSchema.safeParse(schedule);
    if (!parsed.success) {
      return { error: toScheduleError("validation-error", "Stored schedule is malformed") };
    }
    const record = parsed.data;
    if (options?.projectId !== undefined && record.projectId !== options.projectId) {
      return { error: toScheduleError("project-mismatch", "Schedule project mismatch") };
    }
    const run = runs.find((r) => (r.runId as string) === runCheck.id);
    if (!run || (run.scheduleId as string) !== (record.id as string)) {
      return { error: toScheduleError("not-found", "Scheduled run not found") };
    }
    // Idempotent: settling an already-terminal run returns it unchanged.
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return { run: { ...run } };
    }
    const nowIso = toIso(this._clock());
    let detail: string | undefined;
    if (options?.detail !== undefined) {
      if (typeof options.detail !== "string") {
        return { error: toScheduleError("validation-error", "Settle detail must be a string") };
      }
      detail = truncate(
        options.detail.trim().slice(0, MAX_SCHEDULE_ERROR_LENGTH),
        MAX_SCHEDULE_ERROR_LENGTH,
      );
    }
    const settled: ScheduledRunRecord = {
      ...run,
      status: outcome,
      finishedAt: nowIso,
      ...(outcome === "failed" || outcome === "cancelled"
        ? { error: detail ?? run.error ?? `Run ${outcome}.` }
        : {}),
    };
    try {
      await this._store.saveRun({ ...settled });
    } catch {
      return { error: toScheduleError("storage-error", "Schedule store unavailable") };
    }
    await this._pruneRuns(record.id as string);
    if ((await this._activeRunId(record.id as string)) === (run.runId as string)) {
      this._activeRuns.delete(record.id as string);
      try {
        await this._store.setActiveRunId(record.id as string, undefined);
      } catch {
        // Local map is authoritative in-process; persistence is best-effort.
      }
    }
    const updated: ScheduledTaskRecord = {
      ...record,
      updatedAt: nowIso,
      lastRunStatus: outcome === "cancelled" ? record.lastRunStatus : outcome,
    };
    try {
      await this._store.saveSchedule(updated);
    } catch {
      // Outcome already recorded; persistence failure must not fake an error.
    }
    // There is intentionally no schedule.run.cancelled event type: cancelled
    // settles update the run record (auditable via the store) without an event.
    if (outcome === "completed" || outcome === "failed") {
      await this._emit(record, scheduleEventType(`run.${outcome}`), {
        runId: settled.runId,
        status: outcome,
        ...(settled.error !== undefined ? { detail: settled.error } : {}),
      });
    }
    // A parked queue_one occurrence now owns the freed slot.
    const parkedId = await this._parkedRunId(record.id as string);
    if (parkedId !== undefined) {
      const parked = await this._findRun(record.id as string, parkedId);
      if (parked && parked.status === "pending") {
        this._parkedRuns.delete(record.id as string);
        try {
          await this._store.setQueuedRunId(record.id as string, undefined);
        } catch {
          // Local map already cleared.
        }
        const summary = { launched: 0, skipped: 0, queued: 0, failed: 0 };
        await this._launchRecordedRun(record, parked, this._clock(), summary, {
          scheduledForMs: Date.parse(parked.scheduledFor),
          excess: 0,
          latestMs: Date.parse(parked.scheduledFor),
        });
      } else {
        this._parkedRuns.delete(record.id as string);
        try {
          await this._store.setQueuedRunId(record.id as string, undefined);
        } catch {
          // Local map already cleared.
        }
      }
    }
    return { run: { ...settled } };
  }

  // -------------------------------------------------------------------------
  // setEnabled(): flips the enabled flag. Never touches active runs.
  // -------------------------------------------------------------------------

  async setEnabled(
    scheduleId: unknown,
    projectId: unknown,
    enabled: boolean,
  ): Promise<SchedulerScheduleResult> {
    const idCheck = validateId(scheduleId, "scheduleId");
    if (isSchedulerError(idCheck)) return idCheck;
    const projectCheck = validateProjectId(projectId);
    if (isSchedulerError(projectCheck)) return projectCheck;
    if (typeof enabled !== "boolean") {
      return { error: toScheduleError("validation-error", "Enabled must be a boolean") };
    }
    let stored: ScheduledTaskRecord | undefined;
    try {
      stored = await this._store.getSchedule(idCheck.id);
    } catch {
      return { error: toScheduleError("storage-error", "Schedule store unavailable") };
    }
    if (!stored) {
      return { error: toScheduleError("not-found", "Schedule not found") };
    }
    const parsed = ScheduledTaskRecordSchema.safeParse(stored);
    if (!parsed.success) {
      return { error: toScheduleError("validation-error", "Stored schedule is malformed") };
    }
    const schedule = parsed.data;
    if (schedule.projectId !== projectCheck.projectId) {
      return { error: toScheduleError("project-mismatch", "Schedule project mismatch") };
    }
    if (schedule.enabled === enabled) {
      return { schedule: { ...schedule } };
    }
    const updated: ScheduledTaskRecord = { ...schedule, enabled, updatedAt: toIso(this._clock()) };
    try {
      await this._store.saveSchedule(updated);
    } catch {
      return { error: toScheduleError("storage-error", "Schedule store unavailable") };
    }
    await this._emit(schedule, scheduleEventType(enabled ? "enabled" : "disabled"), {
      detail: enabled ? "Schedule enabled." : "Schedule disabled; active runs are untouched.",
    });
    return { schedule: { ...updated } };
  }

  // -------------------------------------------------------------------------
  // recover(): idempotent startup classification. Never launches.
  // -------------------------------------------------------------------------

  async recover(
    persistedSchedules: unknown,
    persistedRuns: unknown,
    nowMs?: number,
  ): Promise<RecoverSummary> {
    const now = nowMs ?? this._clock();
    const summary = { validated: 0, rejected: 0, recomputed: 0, recoveredRuns: 0 };
    if (Array.isArray(persistedSchedules)) {
      const seenInBatch = new Set<string>();
      for (const raw of persistedSchedules) {
        const parsed = ScheduledTaskRecordSchema.safeParse(raw);
        if (!parsed.success) {
          summary.rejected += 1;
          continue;
        }
        const schedule = parsed.data;
        const key = schedule.id as string;
        if (seenInBatch.has(key)) {
          summary.rejected += 1;
          continue;
        }
        seenInBatch.add(key);
        if (!checkSecrets(schedule)) {
          summary.rejected += 1;
          continue;
        }
        const sig = `${key}:${schedule.updatedAt}`;
        if (this._recoveredSigs.has(sig)) {
          // Idempotent replay in-process: same version already classified.
          summary.validated += 1;
          continue;
        }
        let recomputed: ScheduledTaskRecord;
        try {
          recomputed = this._recomputePointer(schedule, now);
        } catch {
          summary.rejected += 1;
          continue;
        }
        const pointerChanged = recomputed.nextRunAt !== schedule.nextRunAt;
        let stored: ScheduledTaskRecord | undefined;
        try {
          stored = await this._store.getSchedule(key);
        } catch {
          summary.rejected += 1;
          continue;
        }
        // Schedule version check: the store already holding this exact record
        // means a previous recovery (this boot or a prior one) classified it.
        if (stored && schedulesEqual(stored, recomputed)) {
          this._recoveredSigs.add(sig);
          summary.validated += 1;
          continue;
        }
        try {
          await this._store.saveSchedule({ ...recomputed });
        } catch {
          summary.rejected += 1;
          continue;
        }
        this._recoveredSigs.add(sig);
        summary.validated += 1;
        if (pointerChanged) summary.recomputed += 1;
      }
    }
    if (Array.isArray(persistedRuns)) {
      const seenRunIds = new Set<string>();
      for (const raw of persistedRuns) {
        const parsed = ScheduledRunRecordSchema.safeParse(raw);
        if (!parsed.success) {
          summary.rejected += 1;
          continue;
        }
        const run = parsed.data;
        const runKey = run.runId as string;
        if (seenRunIds.has(runKey)) {
          summary.rejected += 1;
          continue;
        }
        seenRunIds.add(runKey);
        try {
          if (run.error !== undefined) assertNoSecrets(run.error);
        } catch {
          summary.rejected += 1;
          continue;
        }
        if (this._knownRunIds.has(runKey)) {
          // RunId ledger hit: idempotent replay, no duplicate write.
          summary.recoveredRuns += 1;
          continue;
        }
        this._knownRunIds.add(runKey);
        try {
          await this._store.saveRun({ ...run });
        } catch {
          summary.rejected += 1;
          continue;
        }
        // Rebuild the overlap maps so the first post-restart tick applies
        // overlap policy correctly: running -> active; a pending run with no
        // active owner is adopted (crash before launch), otherwise parked.
        if (run.status === "running") {
          const sid = run.scheduleId as string;
          if (!this._activeRuns.has(sid)) {
            this._activeRuns.set(sid, runKey);
            try {
              await this._store.setActiveRunId(sid, runKey);
            } catch {
              // Local map is authoritative in-process.
            }
          }
        } else if (run.status === "pending") {
          const sid = run.scheduleId as string;
          if (!this._activeRuns.has(sid)) {
            const storeActive = await this._safeActive(sid);
            if (storeActive === undefined) {
              this._activeRuns.set(sid, runKey);
              try {
                await this._store.setActiveRunId(sid, runKey);
              } catch {
                // Local map is authoritative in-process.
              }
            } else if (!this._parkedRuns.has(sid)) {
              this._parkedRuns.set(sid, runKey);
              try {
                await this._store.setQueuedRunId(sid, runKey);
              } catch {
                // Local map is authoritative in-process.
              }
            }
          } else if (!this._parkedRuns.has(sid)) {
            this._parkedRuns.set(sid, runKey);
            try {
              await this._store.setQueuedRunId(sid, runKey);
            } catch {
              // Local map is authoritative in-process.
            }
          }
        }
        summary.recoveredRuns += 1;
        await this._emitRunRecovered(run);
      }
    }
    return { ...summary };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _calcOptions(): { minIntervalMs?: number } {
    return this._minIntervalMs !== undefined ? { minIntervalMs: this._minIntervalMs } : {};
  }

  private _newRun(
    schedule: ScheduledTaskRecord,
    trigger: ScheduleTrigger,
    scheduledFor: string,
  ): ScheduledRunRecord {
    const runId = this._createRunId();
    this._knownRunIds.add(runId as string);
    return {
      runId,
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      trigger,
      status: "pending",
      scheduledFor,
    };
  }

  /** Snapshot of the most recent runNow() launch outcome for the response. */
  private _lastLaunched: { runId: string; run: ScheduledRunRecord } | undefined;

  private _lastLaunchedState(runId: string, fallback: ScheduledRunRecord): ScheduledRunRecord {
    if (this._lastLaunched && this._lastLaunched.runId === runId) {
      return { ...this._lastLaunched.run };
    }
    return { ...fallback };
  }

  private async _activeRunId(scheduleId: string): Promise<string | undefined> {
    const local = this._activeRuns.get(scheduleId);
    if (local !== undefined) return local;
    const stored = await this._safeActive(scheduleId);
    if (stored !== undefined) this._activeRuns.set(scheduleId, stored);
    return stored;
  }

  private async _safeActive(scheduleId: string): Promise<string | undefined> {
    try {
      return await this._store.getActiveRunId(scheduleId);
    } catch {
      return this._activeRuns.get(scheduleId);
    }
  }

  private async _parkedRunId(scheduleId: string): Promise<string | undefined> {
    const local = this._parkedRuns.get(scheduleId);
    if (local !== undefined) return local;
    try {
      const stored = await this._store.getQueuedRunId(scheduleId);
      if (stored !== undefined) this._parkedRuns.set(scheduleId, stored);
      return stored;
    } catch {
      return local;
    }
  }

  private async _findRun(
    scheduleId: string,
    runId: string,
  ): Promise<ScheduledRunRecord | undefined> {
    try {
      const runs = await this._store.listRuns(scheduleId);
      return runs.find((r) => (r.runId as string) === runId);
    } catch {
      return undefined;
    }
  }

  /** First occurrence strictly after now (the post-handling pointer). */
  private _pointerAfter(
    schedule: ScheduledTaskRecord,
    createdAtMs: number,
    handledMs: number,
    now: number,
  ): number {
    let pointer: number | null = null;
    try {
      pointer = nextPointerAfterNow(
        {
          kind: schedule.kind,
          config: schedule.config,
          timezone: schedule.timezone,
          createdAtMs,
          anchorMs: handledMs,
          consumed: false,
        },
        Math.max(handledMs, now),
        this._calcOptions(),
      );
    } catch {
      pointer = null;
    }
    if (pointer !== null) return pointer;
    // One-shot consumed (or unresolvable): keep the handled time as the
    // terminal pointer; enabled=false is set by the caller.
    return handledMs;
  }

  /** Quiet pointer repair when nothing is due (no events, save only on drift). */
  private async _fixPointer(
    schedule: ScheduledTaskRecord,
    anchorMs: number,
    consumed: boolean,
    now: number,
  ): Promise<void> {
    let expected: number | null = null;
    try {
      expected = nextPointerAfterNow(
        {
          kind: schedule.kind,
          config: schedule.config,
          timezone: schedule.timezone,
          createdAtMs: Date.parse(schedule.createdAt),
          anchorMs,
          consumed,
        },
        now,
        this._calcOptions(),
      );
    } catch {
      return;
    }
    if (expected === null) {
      if (!consumed && (schedule.kind === "once" || schedule.kind === "delay")) {
        // Single fire time passed but the due branch found nothing (fire time
        // at or before the anchor edge): leave it for the due path on the
        // next tick rather than disabling silently.
      }
      return;
    }
    const expectedIso = toIso(expected);
    if (expectedIso !== schedule.nextRunAt) {
      const updated: ScheduledTaskRecord = {
        ...schedule,
        updatedAt: toIso(now),
        nextRunAt: expectedIso,
      };
      try {
        await this._store.saveSchedule(updated);
      } catch {
        // Pointer repair is best-effort; the next tick recomputes anyway.
      }
    }
  }

  /**
   * Launches an already-durable pending run record (tick adoption, fresh due
   * runs, and parked runs all converge here). Exactly one launcher call per
   * invocation; launch failure marks the run failed without retry.
   */
  private async _launchRecordedRun(
    schedule: ScheduledTaskRecord,
    run: ScheduledRunRecord,
    now: number,
    summary: { launched: number; skipped: number; queued: number; failed: number },
    aftermath: { scheduledForMs: number; excess: number; latestMs: number },
  ): Promise<void> {
    const nowIso = toIso(now);
    const sid = schedule.id as string;
    const createdAtMs = Date.parse(schedule.createdAt);
    const isOneShot = schedule.kind === "once" || schedule.kind === "delay";
    let outcome: LaunchOutcome;
    try {
      await this._store.saveRun({ ...run });
      this._activeRuns.set(sid, run.runId as string);
      try {
        await this._store.setActiveRunId(sid, run.runId as string);
      } catch {
        // Local map is authoritative in-process.
      }
      outcome = await this._launcher.launch({
        projectId: schedule.projectId,
        goal: schedule.prompt,
        title: schedule.name,
      });
    } catch (err) {
      outcome = {
        error: {
          code: "launch-throw",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if ("backgroundTaskId" in outcome) {
      const running: ScheduledRunRecord = {
        ...run,
        status: "running",
        backgroundTaskId: outcome.backgroundTaskId,
        startedAt: nowIso,
      };
      try {
        await this._store.saveRun({ ...running });
      } catch {
        // Launch succeeded; persistence failure must not fake a failure.
      }
      await this._pruneRuns(sid);
      const pointer = this._pointerAfter(schedule, createdAtMs, aftermath.latestMs, now);
      const updated: ScheduledTaskRecord = {
        ...schedule,
        updatedAt: nowIso,
        nextRunAt: toIso(pointer),
        lastRunAt: toIso(aftermath.latestMs),
        lastRunStatus: "running",
        runCount: schedule.runCount + 1,
        missedCount: schedule.missedCount + aftermath.excess,
        ...(isOneShot ? { enabled: false } : {}),
      };
      try {
        await this._store.saveSchedule(updated);
      } catch {
        // Launch already happened; persistence failure must not fake an error.
      }
      await this._emit(schedule, scheduleEventType("due"), {
        detail: `Schedule due at ${toIso(aftermath.scheduledForMs)}; launching.`,
      });
      await this._emit(schedule, scheduleEventType("run.started"), {
        runId: run.runId,
        status: "running",
        detail: `Run launched for ${toIso(aftermath.scheduledForMs)}.`,
      });
      if (isOneShot) {
        await this._emit(schedule, scheduleEventType("disabled"), {
          detail: "One-shot schedule consumed; auto-disabled.",
        });
      }
      summary.launched += 1;
      return;
    }
    // Launch failure: durable failed run, consumed occurrence (no hot loop),
    // active slot released, no retry by the scheduler.
    const failed: ScheduledRunRecord = {
      ...run,
      status: "failed",
      startedAt: run.startedAt ?? nowIso,
      finishedAt: nowIso,
      error: truncate(
        `launch-error [${outcome.error.code}] ${outcome.error.message}`,
        MAX_SCHEDULE_ERROR_LENGTH,
      ),
    };
    try {
      await this._store.saveRun({ ...failed });
    } catch {
      // Outcome recording is best-effort from here on.
    }
    await this._pruneRuns(sid);
    this._activeRuns.delete(sid);
    try {
      await this._store.setActiveRunId(sid, undefined);
    } catch {
      // Local map already cleared.
    }
    const pointer = this._pointerAfter(schedule, createdAtMs, aftermath.latestMs, now);
    const updated: ScheduledTaskRecord = {
      ...schedule,
      updatedAt: nowIso,
      nextRunAt: toIso(pointer),
      lastRunAt: toIso(aftermath.latestMs),
      lastRunStatus: "failed",
      missedCount: schedule.missedCount + aftermath.excess,
      ...(isOneShot ? { enabled: false } : {}),
    };
    try {
      await this._store.saveSchedule(updated);
    } catch {
      // Best-effort.
    }
    await this._emit(schedule, scheduleEventType("run.failed"), {
      runId: run.runId,
      status: "failed",
      detail: failed.error,
    });
    summary.failed += 1;
  }

  /** runNow() launch of a fresh pending run (periodic pointer untouched). */
  private async _launchNewRun(
    schedule: ScheduledTaskRecord,
    run: ScheduledRunRecord,
  ): Promise<"launched" | "failed"> {
    const nowIso = toIso(this._clock());
    const sid = schedule.id as string;
    let outcome: LaunchOutcome;
    try {
      await this._store.saveRun({ ...run });
      this._activeRuns.set(sid, run.runId as string);
      try {
        await this._store.setActiveRunId(sid, run.runId as string);
      } catch {
        // Local map is authoritative in-process.
      }
      outcome = await this._launcher.launch({
        projectId: schedule.projectId,
        goal: schedule.prompt,
        title: schedule.name,
      });
    } catch (err) {
      outcome = {
        error: {
          code: "launch-throw",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if ("backgroundTaskId" in outcome) {
      const running: ScheduledRunRecord = {
        ...run,
        status: "running",
        backgroundTaskId: outcome.backgroundTaskId,
        startedAt: nowIso,
      };
      try {
        await this._store.saveRun({ ...running });
      } catch {
        // Launch succeeded; persistence failure must not fake a failure.
      }
      await this._pruneRuns(sid);
      // Refresh the ledger-visible state for the returned snapshot.
      this._lastLaunched = { runId: run.runId as string, run: { ...running } };
      await this._emit(schedule, scheduleEventType("run.started"), {
        runId: run.runId,
        status: "running",
        detail: `Manual run launched (${run.trigger}).`,
      });
      return "launched";
    }
    const failed: ScheduledRunRecord = {
      ...run,
      status: "failed",
      startedAt: run.startedAt ?? nowIso,
      finishedAt: nowIso,
      error: truncate(
        `launch-error [${outcome.error.code}] ${outcome.error.message}`,
        MAX_SCHEDULE_ERROR_LENGTH,
      ),
    };
    try {
      await this._store.saveRun({ ...failed });
    } catch {
      // Best-effort.
    }
    await this._pruneRuns(sid);
    this._activeRuns.delete(sid);
    try {
      await this._store.setActiveRunId(sid, undefined);
    } catch {
      // Local map already cleared.
    }
    this._lastLaunched = { runId: run.runId as string, run: { ...failed } };
    await this._emit(schedule, scheduleEventType("run.failed"), {
      runId: run.runId,
      status: "failed",
      detail: failed.error,
    });
    return "failed";
  }

  /**
   * Recovery pointer recompute (decision 8): never trusts a stale nextRunAt
   * blindly and never mutates missedCount/lastRunAt/runCount. A stale (past)
   * pointer is re-pointed at the policy-selected pending occurrence so the
   * next tick applies missedPolicy exactly once; a fresh pointer is snapped
   * back when it drifts from recomputation.
   */
  private _recomputePointer(schedule: ScheduledTaskRecord, now: number): ScheduledTaskRecord {
    const createdAtMs = Date.parse(schedule.createdAt);
    const lastRunMs = schedule.lastRunAt !== undefined ? Date.parse(schedule.lastRunAt) : undefined;
    const isOneShot = schedule.kind === "once" || schedule.kind === "delay";
    const consumed = isOneShot && lastRunMs !== undefined && Number.isFinite(lastRunMs);
    if (consumed) return { ...schedule };
    let anchorMs = lastRunMs !== undefined && Number.isFinite(lastRunMs) ? lastRunMs : createdAtMs;
    if (!Number.isFinite(anchorMs)) {
      throw new Error("validation-error: schedule has no usable anchor timestamp");
    }
    if (schedule.kind === "once") {
      const fireMs = Date.parse((schedule.config as { runAt: string }).runAt);
      if (Number.isFinite(fireMs)) anchorMs = Math.min(anchorMs, fireMs - 1);
    }
    const due = countDueOccurrences(
      {
        kind: schedule.kind,
        config: schedule.config,
        timezone: schedule.timezone,
        createdAtMs,
        anchorMs,
        nowMs: now,
        consumed,
      },
      this._calcOptions(),
    );
    const persistedNext = Date.parse(schedule.nextRunAt);
    if (due.count >= 1 && due.earliestMs !== undefined && due.latestMs !== undefined) {
      // Policy-aware pending occurrence: run_once keeps the earliest due,
      // skip keeps the current (latest) one. Missed accounting stays in tick().
      const pendingMs = schedule.missedPolicy === "run_once" ? due.earliestMs : due.latestMs;
      const pendingIso = toIso(pendingMs);
      if (pendingIso === schedule.nextRunAt) return { ...schedule };
      return { ...schedule, nextRunAt: pendingIso };
    }
    const pointer = nextPointerAfterNow(
      {
        kind: schedule.kind,
        config: schedule.config,
        timezone: schedule.timezone,
        createdAtMs,
        anchorMs,
        consumed,
      },
      now,
      this._calcOptions(),
    );
    // A null pointer with nothing due means a one-shot whose fire time passed
    // without firing: keep the persisted pointer so tick() handles it via the
    // missedPolicy path (run_once launches, skip drops+disables).
    if (pointer === null) return { ...schedule };
    const pointerIso = toIso(pointer);
    if (
      Number.isFinite(persistedNext) &&
      persistedNext > now &&
      pointerIso === schedule.nextRunAt
    ) {
      return { ...schedule };
    }
    if (pointerIso === schedule.nextRunAt) return { ...schedule };
    return { ...schedule, nextRunAt: pointerIso };
  }

  private async _pruneRuns(scheduleId: string): Promise<void> {
    let runs: ScheduledRunRecord[];
    try {
      runs = await this._store.listRuns(scheduleId);
    } catch {
      return;
    }
    if (runs.length <= this._maxRuns) return;
    const protectedIds = new Set<string>();
    const active = this._activeRuns.get(scheduleId);
    const parked = this._parkedRuns.get(scheduleId);
    if (active !== undefined) protectedIds.add(active);
    if (parked !== undefined) protectedIds.add(parked);
    const sorted = [...runs].sort((a, b) => {
      if (a.scheduledFor < b.scheduledFor) return -1;
      if (a.scheduledFor > b.scheduledFor) return 1;
      return (a.runId as string) < (b.runId as string) ? -1 : 1;
    });
    const overflow = runs.length - this._maxRuns;
    const victims = sorted.filter((r) => !protectedIds.has(r.runId as string)).slice(0, overflow);
    for (const victim of victims) {
      try {
        await this._store.deleteRun(victim.runId as string);
      } catch {
        // Pruning is best-effort; the cap is re-checked on the next write.
      }
    }
  }

  private _conversationFor(scheduleId: string): ConversationId {
    let id = this._conversations.get(scheduleId);
    if (!id) {
      // Schedules are project-scoped, not conversation-scoped; schedule events
      // carry a synthetic per-schedule conversationId to satisfy the event
      // envelope. It is stable per scheduler lifetime, not persisted.
      id = createConversationId();
      this._conversations.set(scheduleId, id);
    }
    return id;
  }

  private async _emit(
    schedule: ScheduledTaskRecord,
    type: `schedule.${string}`,
    fields?: { runId?: ScheduledRunId; status?: string; detail?: string },
  ): Promise<void> {
    if (!this._eventSink) return;
    try {
      const event = {
        eventId: createEventId(),
        conversationId: this._conversationFor(schedule.id as string),
        sequence: this._sequence++,
        schemaVersion: 1,
        timestamp: toIso(this._clock()),
        type,
        category: "extension",
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        ...(fields?.runId !== undefined ? { runId: fields.runId } : {}),
        ...(fields?.status !== undefined ? { status: fields.status } : {}),
        ...(fields?.detail !== undefined
          ? { detail: truncate(fields.detail.trim().slice(0, 2000), 2000) }
          : {}),
      } as unknown as AIEvent;
      await this._eventSink.publish(event);
    } catch {
      // Event emission is best-effort; scheduler state already advanced.
    }
  }

  private async _emitRunRecovered(run: ScheduledRunRecord): Promise<void> {
    if (!this._eventSink) return;
    if (run.status !== "pending" && run.status !== "running") return;
    let schedule: ScheduledTaskRecord | undefined;
    try {
      schedule = await this._store.getSchedule(run.scheduleId as string);
    } catch {
      return;
    }
    const parsed = schedule ? ScheduledTaskRecordSchema.safeParse(schedule) : { success: false };
    const anchor: ScheduledTaskRecord | undefined =
      parsed.success === true ? (parsed as { data: ScheduledTaskRecord }).data : undefined;
    if (!anchor) return;
    await this._emit(anchor, scheduleEventType("run.recovered"), {
      runId: run.runId,
      status: run.status,
      detail: "Pending run re-registered after restart; no side effects replayed.",
    });
  }
}

function schedulesEqual(a: ScheduledTaskRecord, b: ScheduledTaskRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
