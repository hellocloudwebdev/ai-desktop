// PR44: apps/desktop — DesktopSchedulerService (Desktop Orchestration Layer)
//
// Thin orchestration around a background-task delegate + the durable
// scheduled-task/run repositories + EventBus/EventRepository. It owns NO
// ReAct loop, NO tool executor, NO permission system, NO memory system, and
// NO provider router: each due firing delegates to
// backgroundTaskService.startTask/start (the existing runtime/graph/tool/
// permission/event path with the SAME projectId), never to tools directly.
//
// Invariants:
//   1. Persistence is a projection/read model: every transition upserts the
//      schedule row {scheduleId,projectId,name,description,prompt,kind,
//      configJson,timezone,enabled,missedPolicy,overlapPolicy,timestamps,
//      nextRunAt/lastRunAt/lastRunStatus,runCount,missedCount,schemaVersion:1}
//      and appends run rows {runId,scheduleId,projectId,backgroundTaskId,
//      trigger,status,scheduledFor,startedAt,finishedAt,error}. Payloads are
//      truncated and secret-scanned before every write; raw secrets never
//      reach storage.
//   2. Events are authoritative: every transition also publishes a
//      schedule.* AIEvent via storage.append THEN EventBus.publish (the same
//      ordering as DesktopEventSink: persistence before delivery).
//   3. Project isolation: projectId is immutable from creation; every
//      operation verifies the caller projectId; launches always pass the
//      schedule's own projectId (never the currently-selected project).
//      Destructive Git ops remain permission-gated downstream inside the
//      background execution path. Nothing auto-commits, pushes, or approves.
//   4. Permissions: the optional permissionManager reference is read-only
//      documentation of the downstream gate. This service never approves,
//      never resolves, and never revokes anything; a run parked in
//      waiting_permission downstream stays parked until the PermissionManager
//      resolves externally.
//   5. Overlap: a tick firing while the previous run is still active either
//      skips (overlap=skip, the occurrence is recorded as a cancelled run
//      row) or defers exactly one launch (overlap=queue_one, the nextRunAt
//      still advances so the timer never hot-loops).
//   6. Missed: occurrences missed while the app was down either skip
//      (missed=skip, counted in missedCount) or catch up at most once
//      (missed=run_once, MAX_SCHEDULE_CATCH_UP=1; the remaining missed
//      occurrences are counted, never launched).
//   7. History bound: run history is retention-pruned to MAX_SCHEDULE_RUN_
//      HISTORY (50) rows per schedule after every write.
//   8. Startup recovery is idempotent and never duplicates launches: stale
//      unfinished run rows (crash mid-launch) are closed as failed without
//      relaunch, and each adopted schedule produces at most one catch-up.
//      A second recover() is a side-effect-free no-op for adopted schedules.
//   9. Disable stops future runs but never kills active tasks; delete stops
//      future runs and preserves run rows (retention prune only).
//  10. Fail closed: malformed ids, oversized strings, secret payloads,
//      invalid timezones, sub-minute intervals, over-cap launches, and
//      cross-project reads all throw SchedulerServiceError ("CODE: message",
//      never a stack or secret echo).
//  11. Renderer-disconnect safety: no WebContents state is ever consulted.
//  12. Electron-free: this file imports no Electron APIs (Node timers only).
//
// Canonical alignment note: schedule/run vocabulary (event names, run
// statuses, triggers, policies) is canonical in
// packages/ai-core/src/schedules.ts. This file imports the canonical event
// builder (scheduleEventType) and mirrors the canonical enums locally so the
// service boundary stays structural. The local pure next-run calculator
// (once/delay/interval/daily/weekly with Intl timezones) remains the default;
// a compatible calculator can be injected via deps.calculator. Caps mirror
// the canonical vocabulary (32 schedules, 8 concurrent runs, 60s minimum
// interval, 1 catch-up, 50 history rows) so enforcement lives main-side.

import {
  assertNoSecrets,
  createEventId,
  createScheduledRunId,
  createScheduleId,
  scheduleEventType,
  type AIEvent,
  type ConversationId,
  type ScheduleEventType,
} from "@ai-desktop/ai-core";
import { isUlid } from "@ai-desktop/shared";
import type { EventRepository, ScheduledRunRow, ScheduledTaskRow } from "@ai-desktop/storage";

// ---------------------------------------------------------------------------
// Schedule vocabulary (local structural ports; see sibling-interop note)
// ---------------------------------------------------------------------------

export type ScheduleKind = "once" | "delay" | "interval" | "daily" | "weekly";

export interface ScheduleOnceConfig {
  readonly kind: "once";
  readonly runAt: string;
}

export interface ScheduleDelayConfig {
  readonly kind: "delay";
  readonly delayMs: number;
}

export interface ScheduleIntervalConfig {
  readonly kind: "interval";
  readonly intervalMs: number;
}

export interface ScheduleDailyConfig {
  readonly kind: "daily";
  readonly dailyTime: string;
}

export interface ScheduleWeeklyConfig {
  readonly kind: "weekly";
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

export type ScheduleSpec =
  | ScheduleOnceConfig
  | ScheduleDelayConfig
  | ScheduleIntervalConfig
  | ScheduleDailyConfig
  | ScheduleWeeklyConfig;

/** Loose creator/update input: normalized shapes plus common aliases. */
export type ScheduleSpecInput =
  | ScheduleSpec
  | { readonly kind: "once"; readonly at: number | string }
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | { readonly kind: "daily"; readonly time: string };

export type ScheduleMissedPolicy = "skip" | "run_once";
export type ScheduleOverlapPolicy = "skip" | "queue_one";
export type ScheduleRunTrigger = "scheduled" | "manual" | "recovery";
/** Canonical run statuses (ai-core ScheduledRunStatusSchema). */
export type ScheduleRunStatus =
  "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export const SCHEDULE_SCHEMA_VERSION = 1;
/** Maximum schedules retained workspace-wide (main-side enforcement). */
export const MAX_SCHEDULES_TOTAL = 32;
/** Maximum schedule-triggered runs concurrently launching. */
export const MAX_CONCURRENT_SCHEDULE_RUNS = 8;
/** Minimum interval between recurring ticks (sub-minute rejected). */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
/** Maximum missed occurrences caught up after downtime (rest skip). */
export const MAX_SCHEDULE_CATCH_UP = 1;
/** Maximum run-history rows retained per schedule. */
export const MAX_SCHEDULE_RUN_HISTORY = 50;
/** Default single-timer cadence when deps.tickMs is absent. */
export const DEFAULT_SCHEDULER_TICK_MS = 30_000;

const MISSED_GRACE_MS = 60_000;
const MAX_DELAY_MS = 31_536_000_000;
const MAX_INTERVAL_MS = 31_536_000_000;
const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 4000;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ERROR_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Minimal ports (structural: real implementations and test stubs both fit)
// ---------------------------------------------------------------------------

/**
 * Background execution port. Accepts either the AgentService-shaped
 * startTask delegate or the DesktopBackgroundTaskService-shaped start
 * delegate; launches always carry the schedule's own projectId.
 */
export interface SchedulerBackgroundDelegate {
  startTask?(input: {
    goal: string;
    projectId?: string;
    conversationId?: ConversationId;
  }): Promise<unknown>;
  start?(input: { projectId: string; goal: string; title?: string }): Promise<unknown>;
  getTaskStatus?(taskId: string): string | undefined;
  cancelTask?(taskId: string, reason?: string): boolean;
}

/** Durable schedule projection port (PrismaScheduledTaskRepository fits). */
export interface ScheduleStore {
  upsert(record: ScheduledTaskRow): Promise<void>;
  get(scheduleId: string): Promise<ScheduledTaskRow | null>;
  listByProject(projectId: string): Promise<ScheduledTaskRow[]>;
  listAll(): Promise<ScheduledTaskRow[]>;
  listEnabled(): Promise<ScheduledTaskRow[]>;
  remove(scheduleId: string): Promise<boolean>;
}

export interface ScheduleRunPatch {
  readonly backgroundTaskId?: string | null;
  readonly status?: string;
  readonly startedAt?: number | null;
  readonly finishedAt?: number | null;
  readonly error?: string | null;
}

/** Durable run-history port (PrismaScheduledRunRepository fits). */
export interface ScheduleRunStore {
  create(record: ScheduledRunRow): Promise<void>;
  get(runId: string): Promise<ScheduledRunRow | null>;
  listBySchedule(scheduleId: string, limit?: number): Promise<ScheduledRunRow[]>;
  listUnfinished(scheduleId?: string): Promise<ScheduledRunRow[]>;
  update(runId: string, patch: ScheduleRunPatch): Promise<boolean>;
  pruneRuns(scheduleId: string, keepLatest: number): Promise<number>;
}

/** Event transport port: publish-only view of EventBus. */
export interface SchedulerEventTransport {
  publish(event: Readonly<AIEvent>): Promise<void>;
}

export interface DesktopSchedulerServiceDeps {
  readonly backgroundTaskService: SchedulerBackgroundDelegate;
  readonly scheduleRepo: ScheduleStore;
  readonly runRepo: ScheduleRunStore;
  readonly eventBus: SchedulerEventTransport;
  readonly storage: EventRepository;
  /**
   * Read-only reference to the downstream permission gate. Never invoked,
   * never auto-approving: destructive and gated tool calls stay mediated by
   * the existing executors inside the background execution path.
   */
  readonly permissionManager?: unknown;
  readonly clock?: () => number;
  readonly tickMs?: number;
  /**
   * Optional sibling calculator override
   * (packages/agent-runtime/src/runtime/scheduling). When absent, the local
   * pure computeScheduleNextRun below is used.
   */
  readonly calculator?: (spec: ScheduleSpec, timezone: string, fromMs: number) => number | null;
}

export interface CreateScheduleInput {
  readonly projectId: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ScheduleSpecInput;
  readonly timezone?: string;
  readonly description?: string;
  readonly missedPolicy?: ScheduleMissedPolicy;
  readonly overlapPolicy?: ScheduleOverlapPolicy | "queue";
  readonly enabled?: boolean;
}

export interface UpdateScheduleInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly prompt?: string;
  readonly schedule?: ScheduleSpecInput;
  readonly timezone?: string;
  readonly missedPolicy?: ScheduleMissedPolicy;
  readonly overlapPolicy?: ScheduleOverlapPolicy | "queue";
}

/** Renderer-safe projection: normalized fields only, never raw internals. */
export interface ScheduleProjection {
  readonly scheduleId: string;
  readonly projectId: string;
  readonly name: string;
  readonly description?: string;
  readonly scheduleDescription?: string;
  readonly prompt: string;
  readonly schedule: ScheduleSpec;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly missedPolicy: ScheduleMissedPolicy;
  readonly overlapPolicy: ScheduleOverlapPolicy;
  readonly overlap: "skip" | "queue";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt?: string;
  readonly lastRunStatus?: string;
  readonly runCount: number;
  readonly missedCount: number;
}

export interface ScheduledRunProjection {
  readonly runId: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly backgroundTaskId?: string;
  readonly taskId?: string;
  readonly trigger: ScheduleRunTrigger;
  readonly status: string;
  readonly scheduledFor: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly errorSnippet?: string;
}

export interface SchedulerRecoverySummary {
  readonly schedules: number;
  readonly caughtUp: number;
  readonly skipped: number;
  readonly closed: number;
  readonly ignored: number;
}

export class SchedulerServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SchedulerServiceError";
    this.code = code;
  }
}

interface ScheduleEntry {
  scheduleId: string;
  projectId: string;
  name: string;
  description?: string;
  prompt: string;
  spec: ScheduleSpec;
  timezone: string;
  enabled: boolean;
  missedPolicy: ScheduleMissedPolicy;
  overlapPolicy: ScheduleOverlapPolicy;
  createdAt: string;
  updatedAt: string;
  nextRunAt: number | null;
  lastRunAt?: number;
  lastRunStatus?: string;
  runCount: number;
  missedCount: number;
}

/**
 * Canonical schedule event names live in ai-core (SCHEDULE_EVENT_TYPES);
 * this service builds them via the canonical scheduleEventType() allowlist
 * so producers cannot invent ad-hoc types. Event vocabulary:
 * created/updated/enabled/disabled/deleted/due + run.started/run.completed/
 * run.failed/run.skipped/run.recovered. `run.completed` is currently unused
 * (the scheduler hands off to BackgroundTaskManager and does not track
 * downstream task completion); a launched run is recorded completed with a
 * run.started event. Skips (missed/overlap/concurrency) record status
 * `skipped` with a run.skipped event whose detail carries the reason.
 */

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function refuseSecrets(value: unknown): void {
  try {
    assertNoSecrets(value);
  } catch {
    throw new SchedulerServiceError(
      "secret-refused",
      "refusing to persist schedule payload: value appears to contain secret material",
    );
  }
}

function requireProjectId(projectId: string): string {
  const trimmed = (projectId ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new SchedulerServiceError(
      "validation-error",
      "projectId must be a non-empty string of at most 256 characters",
    );
  }
  return trimmed;
}

function requireScheduleId(scheduleId: string): string {
  if (typeof scheduleId !== "string" || !isUlid(scheduleId)) {
    // Fail closed without an oracle: malformed ids read as not-found.
    throw new SchedulerServiceError("not-found", "schedule was not found");
  }
  return scheduleId.toUpperCase();
}

function requireName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new SchedulerServiceError(
      "validation-error",
      "name must be a non-empty string of at most 120 characters",
    );
  }
  return trimmed;
}

function requirePrompt(prompt: string): string {
  const trimmed = (prompt ?? "").trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_LENGTH) {
    throw new SchedulerServiceError(
      "validation-error",
      "prompt must be a non-empty string of at most 4000 characters",
    );
  }
  return trimmed;
}

function normalizeDescription(description: string | null | undefined): string | undefined {
  if (description === undefined || description === null) return undefined;
  const trimmed = description.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new SchedulerServiceError(
      "validation-error",
      "description must be at most 2000 characters",
    );
  }
  return trimmed;
}

function requireTimezone(timezone: string | undefined, fallback: string): string {
  const candidate = (timezone ?? fallback).trim() || fallback;
  if (candidate.length === 0 || candidate.length > 64) {
    throw new SchedulerServiceError(
      "validation-error",
      "timezone must be a non-empty string of at most 64 characters",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
  } catch {
    throw new SchedulerServiceError(
      "validation-error",
      `timezone "${candidate}" is not a valid IANA timezone`,
    );
  }
  return candidate;
}

function normalizeMissedPolicy(value: unknown): ScheduleMissedPolicy {
  if (value === undefined) return "skip";
  if (value === "skip" || value === "run_once") return value;
  throw new SchedulerServiceError("validation-error", 'missedPolicy must be "skip" or "run_once"');
}

function normalizeOverlapPolicy(value: unknown): ScheduleOverlapPolicy {
  if (value === undefined) return "skip";
  if (value === "skip") return "skip";
  if (value === "queue_one" || value === "queue") return "queue_one";
  throw new SchedulerServiceError(
    "validation-error",
    'overlapPolicy must be "skip" or "queue_one"',
  );
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** Validates + normalizes any creator/update schedule input to canonical form. */
function normalizeScheduleSpec(input: unknown): ScheduleSpec {
  if (!input || typeof input !== "object") {
    throw new SchedulerServiceError("validation-error", "schedule must be an object");
  }
  const raw = input as Record<string, unknown>;
  switch (raw.kind) {
    case "once": {
      const candidate = raw.runAt ?? raw.at;
      const ms =
        typeof candidate === "number"
          ? candidate
          : typeof candidate === "string"
            ? Date.parse(candidate.trim())
            : Number.NaN;
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new SchedulerServiceError(
          "validation-error",
          "once schedules require a valid runAt timestamp",
        );
      }
      return { kind: "once", runAt: new Date(ms).toISOString() };
    }
    case "delay": {
      const delayMs = raw.delayMs;
      if (
        typeof delayMs !== "number" ||
        !Number.isInteger(delayMs) ||
        delayMs < 1000 ||
        delayMs > MAX_DELAY_MS
      ) {
        throw new SchedulerServiceError(
          "validation-error",
          "delay schedules require delayMs between 1000 and 31536000000",
        );
      }
      return { kind: "delay", delayMs };
    }
    case "interval": {
      const candidate = raw.intervalMs ?? raw.everyMs;
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        Math.floor(candidate) < MIN_SCHEDULE_INTERVAL_MS ||
        Math.floor(candidate) > MAX_INTERVAL_MS
      ) {
        throw new SchedulerServiceError(
          "validation-error",
          "interval schedules require intervalMs of at least 60000",
        );
      }
      return { kind: "interval", intervalMs: Math.floor(candidate) };
    }
    case "daily": {
      const dailyTimeRaw =
        typeof raw.dailyTime === "string"
          ? raw.dailyTime.trim()
          : typeof raw.time === "string"
            ? raw.time.trim()
            : null;
      if (dailyTimeRaw && /^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTimeRaw)) {
        return { kind: "daily", dailyTime: dailyTimeRaw };
      }
      const hour = raw.hour;
      const minute = raw.minute ?? raw.min;
      if (
        typeof hour === "number" &&
        Number.isInteger(hour) &&
        hour >= 0 &&
        hour <= 23 &&
        typeof minute === "number" &&
        Number.isInteger(minute) &&
        minute >= 0 &&
        minute <= 59
      ) {
        return { kind: "daily", dailyTime: `${pad2(hour)}:${pad2(minute)}` };
      }
      throw new SchedulerServiceError(
        "validation-error",
        "daily schedules require dailyTime as HH:MM (00:00-23:59)",
      );
    }
    case "weekly": {
      const weekday = raw.weekday;
      const hour = raw.hour;
      const minute = raw.minute ?? raw.min;
      if (
        typeof weekday !== "number" ||
        !Number.isInteger(weekday) ||
        weekday < 0 ||
        weekday > 6 ||
        typeof hour !== "number" ||
        !Number.isInteger(hour) ||
        hour < 0 ||
        hour > 23 ||
        typeof minute !== "number" ||
        !Number.isInteger(minute) ||
        minute < 0 ||
        minute > 59
      ) {
        throw new SchedulerServiceError(
          "validation-error",
          "weekly schedules require weekday 0-6, hour 0-23, and minute 0-59",
        );
      }
      return { kind: "weekly", weekday, hour, minute };
    }
    default:
      throw new SchedulerServiceError(
        "validation-error",
        "schedule kind must be once, delay, interval, daily, or weekly",
      );
  }
}

function parseDailyTime(dailyTime: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dailyTime.trim());
  if (!match) {
    throw new SchedulerServiceError(
      "validation-error",
      "daily schedules require dailyTime as HH:MM (00:00-23:59)",
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function tzOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - utcMs;
}

function zonedWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i += 1) {
    utc = Date.UTC(year, month - 1, day, hour, minute, 0) - tzOffsetMs(timeZone, utc);
  }
  return utc;
}

function tzWallDate(
  timeZone: string,
  utcMs: number,
): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function nextDailyUtc(timeZone: string, hour: number, minute: number, fromMs: number): number {
  const wall = tzWallDate(timeZone, fromMs);
  let candidate = zonedWallToUtc(wall.year, wall.month, wall.day, hour, minute, timeZone);
  if (candidate <= fromMs) {
    const nextDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + 86_400_000);
    candidate = zonedWallToUtc(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

function nextWeeklyUtc(
  timeZone: string,
  weekday: number,
  hour: number,
  minute: number,
  fromMs: number,
): number {
  const wall = tzWallDate(timeZone, fromMs);
  const ahead = (weekday - wall.weekday + 7) % 7;
  const base = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + ahead * 86_400_000);
  let candidate = zonedWallToUtc(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    base.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
  if (candidate <= fromMs) {
    const nextWeek = new Date(base.getTime() + 7 * 86_400_000);
    candidate = zonedWallToUtc(
      nextWeek.getUTCFullYear(),
      nextWeek.getUTCMonth() + 1,
      nextWeek.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

/**
 * Minimal pure next-run calculator (local fallback). Returns the next UTC
 * epoch-ms strictly after fromMs for repeating kinds; once returns its fixed
 * instant (callers treat past instants as due, then spend the schedule).
 */
export function computeScheduleNextRun(
  spec: ScheduleSpec,
  timezone: string,
  fromMs: number,
): number | null {
  requireTimezone(timezone, "UTC");
  if (!Number.isFinite(fromMs)) {
    throw new SchedulerServiceError("validation-error", "schedule clock produced an invalid time");
  }
  switch (spec.kind) {
    case "once": {
      const at = Date.parse(spec.runAt);
      if (!Number.isFinite(at)) {
        throw new SchedulerServiceError(
          "validation-error",
          "once schedules require a valid runAt timestamp",
        );
      }
      return at;
    }
    case "delay":
      return fromMs + spec.delayMs;
    case "interval":
      return fromMs + spec.intervalMs;
    case "daily": {
      const { hour, minute } = parseDailyTime(spec.dailyTime);
      return nextDailyUtc(timezone, hour, minute, fromMs);
    }
    case "weekly":
      return nextWeeklyUtc(timezone, spec.weekday, spec.hour, spec.minute, fromMs);
  }
}

function periodMsFor(spec: ScheduleSpec): number | null {
  switch (spec.kind) {
    case "interval":
      return spec.intervalMs;
    case "daily":
      return 86_400_000;
    case "weekly":
      return 604_800_000;
    default:
      return null;
  }
}

/** Total occurrences due as of nowMs (the due one plus any extra missed). */
function totalOccurrences(spec: ScheduleSpec, scheduledFor: number, nowMs: number): number {
  const overdue = nowMs - scheduledFor;
  if (overdue <= 0) return 1;
  const period = periodMsFor(spec);
  if (period == null) return 1;
  return Math.floor(overdue / period) + 1;
}

function isMissed(spec: ScheduleSpec, scheduledFor: number, nowMs: number): boolean {
  const overdue = nowMs - scheduledFor;
  if (overdue <= 0) return false;
  const period = periodMsFor(spec);
  if (period != null) return overdue >= period;
  return overdue > MISSED_GRACE_MS;
}

function extractTaskId(result: unknown): string | null {
  if (typeof result === "string") {
    return isUlid(result) ? result.toUpperCase() : null;
  }
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (typeof record.taskId === "string" && isUlid(record.taskId)) {
    return record.taskId.toUpperCase();
  }
  const nested = record.task;
  if (nested && typeof nested === "object") {
    const nestedId = (nested as Record<string, unknown>).taskId;
    if (typeof nestedId === "string" && isUlid(nestedId)) return nestedId.toUpperCase();
  }
  return null;
}

/**
 * DesktopSchedulerService: thin schedule orchestration over the existing
 * background-task execution path with durable projections + recovery.
 */
export class DesktopSchedulerService {
  private readonly _background: SchedulerBackgroundDelegate;
  private readonly _schedules: ScheduleStore;
  private readonly _runs: ScheduleRunStore;
  private readonly _bus: SchedulerEventTransport;
  private readonly _storage: EventRepository;
  private readonly _clock?: () => number;
  private readonly _tickMs: number;
  private readonly _calculator?: (
    spec: ScheduleSpec,
    timezone: string,
    fromMs: number,
  ) => number | null;
  private readonly _entries = new Map<string, ScheduleEntry>();
  private readonly _active = new Set<string>();
  private readonly _queued = new Set<string>();
  private readonly _recoverySeen = new Set<string>();
  private readonly _sequenceCounters = new Map<string, number>();
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _ticking = false;

  constructor(deps: DesktopSchedulerServiceDeps) {
    this._background = deps.backgroundTaskService;
    // The permissionManager slot is a read-only reference documenting the
    // downstream gate; execution stays on the background delegate either way.
    void deps.permissionManager;
    this._schedules = deps.scheduleRepo;
    this._runs = deps.runRepo;
    this._bus = deps.eventBus;
    this._storage = deps.storage;
    if (deps.clock) this._clock = deps.clock;
    this._tickMs =
      deps.tickMs !== undefined && Number.isFinite(deps.tickMs) && deps.tickMs >= 10
        ? Math.floor(deps.tickMs)
        : DEFAULT_SCHEDULER_TICK_MS;
    if (deps.calculator) this._calculator = deps.calculator;
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  async create(input: CreateScheduleInput): Promise<ScheduleProjection> {
    const projectId = requireProjectId(input.projectId);
    const name = requireName(input.name);
    const prompt = requirePrompt(input.prompt);
    const description = normalizeDescription(input.description);
    const timezone = requireTimezone(input.timezone, "UTC");
    const spec = normalizeScheduleSpec(input.schedule);
    const missedPolicy = normalizeMissedPolicy(input.missedPolicy);
    const overlapPolicy = normalizeOverlapPolicy(input.overlapPolicy);
    const enabled = input.enabled ?? true;
    refuseSecrets({ name, prompt, description });

    let existing: ScheduledTaskRow[];
    try {
      existing = await this._schedules.listAll();
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    if (existing.length >= MAX_SCHEDULES_TOTAL) {
      throw new SchedulerServiceError(
        "limit-reached",
        `at most ${MAX_SCHEDULES_TOTAL} schedules are retained`,
      );
    }

    const nowMs = this._nowMs();
    const timestamp = new Date(nowMs).toISOString();
    const scheduleId = createScheduleId();
    const entry: ScheduleEntry = {
      scheduleId,
      projectId,
      name,
      ...(description !== undefined ? { description } : {}),
      prompt,
      spec,
      timezone,
      enabled,
      missedPolicy,
      overlapPolicy,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: this._computeNext(spec, timezone, nowMs),
      runCount: 0,
      missedCount: 0,
    };
    this._entries.set(scheduleId, entry);
    try {
      await this._persist(entry);
    } catch (err) {
      this._entries.delete(scheduleId);
      throw err;
    }
    this._recoverySeen.add(scheduleId);
    await this._emitSchedule(entry, "created");
    return this._project(entry);
  }

  async list(projectId: string): Promise<ScheduleProjection[]> {
    const scoped = requireProjectId(projectId);
    let rows: ScheduledTaskRow[];
    try {
      rows = await this._schedules.listByProject(scoped);
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    const seen = new Set<string>();
    const projections: Array<{ createdAt: string; projection: ScheduleProjection }> = [];
    for (const row of rows) {
      if (typeof row.scheduleId !== "string" || seen.has(row.scheduleId)) continue;
      seen.add(row.scheduleId);
      const entry = this._entries.get(row.scheduleId) ?? this._entryFromRow(row);
      if (!entry || entry.projectId !== scoped) continue;
      projections.push({ createdAt: entry.createdAt, projection: this._project(entry) });
    }
    for (const entry of this._entries.values()) {
      if (entry.projectId !== scoped || seen.has(entry.scheduleId)) continue;
      seen.add(entry.scheduleId);
      projections.push({ createdAt: entry.createdAt, projection: this._project(entry) });
    }
    projections.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return projections.map((p) => p.projection);
  }

  async get(scheduleId: string, projectId: string): Promise<ScheduleProjection> {
    const entry = await this._requireOwned(scheduleId, projectId);
    return this._project(entry);
  }

  async update(
    scheduleId: string,
    projectId: string,
    patch: UpdateScheduleInput,
  ): Promise<ScheduleProjection> {
    const entry = await this._requireOwned(scheduleId, projectId);
    if (patch.name !== undefined) entry.name = requireName(patch.name);
    if (patch.description !== undefined) {
      const next = normalizeDescription(patch.description);
      if (next === undefined) {
        entry.description = undefined;
      } else {
        entry.description = next;
      }
    }
    if (patch.prompt !== undefined) entry.prompt = requirePrompt(patch.prompt);
    if (patch.timezone !== undefined) entry.timezone = requireTimezone(patch.timezone, "UTC");
    if (patch.missedPolicy !== undefined)
      entry.missedPolicy = normalizeMissedPolicy(patch.missedPolicy);
    if (patch.overlapPolicy !== undefined) {
      entry.overlapPolicy = normalizeOverlapPolicy(patch.overlapPolicy);
    }
    let reschedule = false;
    if (patch.schedule !== undefined) {
      entry.spec = normalizeScheduleSpec(patch.schedule);
      reschedule = true;
    }
    if (patch.timezone !== undefined) reschedule = true;
    refuseSecrets({ name: entry.name, prompt: entry.prompt, description: entry.description });
    if (reschedule) {
      entry.nextRunAt = this._computeNext(entry.spec, entry.timezone, this._nowMs());
    }
    entry.updatedAt = new Date(this._nowMs()).toISOString();
    await this._persist(entry);
    await this._emitSchedule(entry, "updated");
    return this._project(entry);
  }

  async enable(scheduleId: string, projectId: string): Promise<ScheduleProjection> {
    const entry = await this._requireOwned(scheduleId, projectId);
    if (entry.enabled) return this._project(entry);
    entry.enabled = true;
    // A spent one-shot stays spent; repeating schedules without a next run
    // resume from now. A stale past nextRunAt is left for the tick, which
    // applies the missed policy exactly once.
    if (entry.nextRunAt == null && entry.spec.kind !== "once" && entry.spec.kind !== "delay") {
      entry.nextRunAt = this._computeNext(entry.spec, entry.timezone, this._nowMs());
    }
    entry.updatedAt = new Date(this._nowMs()).toISOString();
    await this._persist(entry);
    await this._emitSchedule(entry, "enabled");
    return this._project(entry);
  }

  async disable(scheduleId: string, projectId: string): Promise<ScheduleProjection> {
    const entry = await this._requireOwned(scheduleId, projectId);
    if (!entry.enabled) return this._project(entry);
    entry.enabled = false;
    // Drop a deferred queue_one launch: disable stops future runs. Active
    // launches are never killed; their finally block observes the flag.
    this._queued.delete(entry.scheduleId);
    entry.updatedAt = new Date(this._nowMs()).toISOString();
    await this._persist(entry);
    await this._emitSchedule(entry, "disabled");
    return this._project(entry);
  }

  async delete(
    scheduleId: string,
    projectId: string,
  ): Promise<{ deleted: boolean; scheduleId: string }> {
    const entry = await this._requireOwned(scheduleId, projectId);
    const id = entry.scheduleId;
    // Retention prune only: run history is preserved up to the bound.
    try {
      await this._runs.pruneRuns(id, MAX_SCHEDULE_RUN_HISTORY);
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    let deleted: boolean;
    try {
      deleted = await this._schedules.remove(id);
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    this._entries.delete(id);
    this._queued.delete(id);
    await this._emitSchedule(entry, "deleted");
    return { deleted, scheduleId: id };
  }

  /** Alias for delete (removal teardown paths). */
  async remove(
    scheduleId: string,
    projectId: string,
  ): Promise<{ deleted: boolean; scheduleId: string }> {
    return this.delete(scheduleId, projectId);
  }

  /**
   * Launches one explicit manual run (trigger=manual). Manual runs never
   * advance nextRunAt, never auto-approve, and work on disabled schedules;
   * the concurrency cap still fails closed.
   */
  async runNow(
    scheduleId: string,
    projectId: string,
  ): Promise<{ schedule: ScheduleProjection; run: ScheduledRunProjection }> {
    const entry = await this._requireOwned(scheduleId, projectId);
    if (this._active.size >= MAX_CONCURRENT_SCHEDULE_RUNS) {
      throw new SchedulerServiceError(
        "concurrency-limited",
        `schedule-triggered runs are limited (${MAX_CONCURRENT_SCHEDULE_RUNS} active)`,
      );
    }
    const nowMs = this._nowMs();
    const runId = await this._launch(entry, "manual", nowMs, false);
    const row = await this._readRun(runId, entry);
    return { schedule: this._project(entry), run: this._projectRun(row, entry.projectId) };
  }

  async listRuns(
    scheduleId: string,
    projectId: string,
    limit?: number,
  ): Promise<ScheduledRunProjection[]> {
    const take = limit === undefined ? 20 : Math.max(1, Math.min(100, Math.floor(limit)));
    let scopedProject: string;
    let canonicalId: string;
    try {
      const entry = await this._requireOwned(scheduleId, projectId);
      scopedProject = entry.projectId;
      canonicalId = entry.scheduleId;
    } catch (err) {
      // History survives the definition delete (retention prune only):
      // when the schedule row is gone, scope the surviving run rows by
      // their own bound projectId instead. Wrong-project callers see an
      // empty history (fail closed without an existence oracle).
      if (!(err instanceof SchedulerServiceError) || err.code !== "not-found") {
        throw err;
      }
      scopedProject = requireProjectId(projectId);
      canonicalId = scheduleId.toUpperCase();
    }
    let rows: ScheduledRunRow[];
    try {
      rows = await this._runs.listBySchedule(canonicalId, take);
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    const projections: ScheduledRunProjection[] = [];
    for (const row of rows) {
      if (row.scheduleId !== canonicalId) continue;
      if (row.projectId !== scopedProject) continue;
      const validated = this._validateRunRow(row);
      if (!validated) continue;
      projections.push(this._projectRun(validated, scopedProject));
    }
    return projections.slice(0, take);
  }

  // -------------------------------------------------------------------------
  // Single-timer tick + startup recovery
  // -------------------------------------------------------------------------

  /** Starts the single timer loop (idempotent). */
  start(): void {
    if (this._timer !== undefined) return;
    this._timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this._tickMs);
    const handle = this._timer as unknown as { unref?: () => void };
    if (typeof handle.unref === "function") handle.unref();
  }

  /** Stops the timer loop (idempotent; never kills active tasks). */
  stop(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * Processes due schedules once. Non-reentrant: a concurrent tick returns
   * immediately (the next timer tick picks up remaining dues). Launches are
   * kicked off without awaiting so overlap windows stay observable; the
   * durable rows + events settle shortly after (flush with a macrotask in
   * tests via setImmediate).
   */
  async tick(nowMs?: number): Promise<void> {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const now = nowMs ?? this._nowMs();
      let rows: ScheduledTaskRow[];
      try {
        rows = await this._schedules.listEnabled();
      } catch {
        throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
      }
      const due: ScheduleEntry[] = [];
      for (const row of rows) {
        const entry = this._validateRow(row);
        if (!entry || !entry.enabled) continue;
        this._entries.set(entry.scheduleId, entry);
        if (entry.nextRunAt != null && entry.nextRunAt <= now) due.push(entry);
      }
      due.sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
      for (const entry of due) {
        const current = this._entries.get(entry.scheduleId);
        if (!current || !current.enabled) continue;
        await this._fireDue(current, now);
      }
    } finally {
      this._ticking = false;
    }
  }

  /**
   * Idempotent startup recovery: adopts durable schedules, closes stale
   * unfinished runs as failed (never relaunches them), then applies the
   * missed policy per due schedule with at most one catch-up each. A second
   * call is a side-effect-free no-op for already-adopted schedules.
   */
  async recover(): Promise<SchedulerRecoverySummary> {
    let rows: ScheduledTaskRow[];
    try {
      rows = await this._schedules.listAll();
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    const summary = { schedules: 0, caughtUp: 0, skipped: 0, closed: 0, ignored: 0 };
    const seen = new Set<string>();
    for (const row of rows) {
      const rawId = typeof row.scheduleId === "string" ? row.scheduleId : "";
      if (!rawId || seen.has(rawId)) {
        summary.ignored += 1;
        continue;
      }
      seen.add(rawId);
      if (this._recoverySeen.has(rawId)) continue;
      const entry = this._validateRow(row);
      if (!entry) {
        summary.ignored += 1;
        this._recoverySeen.add(rawId);
        continue;
      }
      this._entries.set(entry.scheduleId, entry);
      this._recoverySeen.add(entry.scheduleId);
      summary.schedules += 1;
      let unfinished: ScheduledRunRow[] = [];
      try {
        unfinished = await this._runs.listUnfinished(entry.scheduleId);
      } catch {
        unfinished = [];
      }
      const nowMs = this._nowMs();
      for (const stale of unfinished) {
        try {
          await this._runs.update(stale.runId, {
            status: "failed",
            finishedAt: nowMs,
            error:
              "recovered: scheduler restarted during launch; outcome unknown, never auto-retried",
          });
          summary.closed += 1;
        } catch {
          // recovery markers are best-effort; never fail startup over them
        }
      }
      if (!entry.enabled) continue;
      if (entry.nextRunAt == null) {
        // A spent one-shot stays spent; repeating schedules resume from now.
        if (entry.spec.kind === "once" || entry.spec.kind === "delay") continue;
        entry.nextRunAt = this._computeNext(entry.spec, entry.timezone, nowMs);
        entry.updatedAt = new Date(nowMs).toISOString();
        try {
          await this._persist(entry);
        } catch {
          throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
        }
      }
      if (entry.nextRunAt != null && entry.nextRunAt <= nowMs) {
        const scheduledFor = entry.nextRunAt;
        const missed = isMissed(entry.spec, scheduledFor, nowMs);
        const total = totalOccurrences(entry.spec, scheduledFor, nowMs);
        if (!missed || entry.missedPolicy === "run_once") {
          if (missed) entry.missedCount += Math.max(0, total - MAX_SCHEDULE_CATCH_UP);
          try {
            await this._launch(entry, missed ? "recovery" : "scheduled", scheduledFor, true);
            summary.caughtUp += 1;
          } catch {
            // _launch records failed runs; only storage loss throws, and the
            // schedule stays adopted for the next recovery pass.
          }
        } else {
          try {
            await this._recordSkip(entry, scheduledFor, total, nowMs, "missed");
            summary.skipped += 1;
          } catch {
            // best-effort; the schedule stays adopted for the next pass
          }
        }
      }
      try {
        await this._emitSchedule(entry, "run.recovered");
      } catch {
        // recovery markers are best-effort; never fail startup over them
      }
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Due processing + launching (thin: delegate everything downstream)
  // -------------------------------------------------------------------------

  private async _fireDue(entry: ScheduleEntry, nowMs: number): Promise<void> {
    try {
      const scheduledFor = entry.nextRunAt;
      if (scheduledFor == null || scheduledFor > nowMs) return;
      const missed = isMissed(entry.spec, scheduledFor, nowMs);
      const total = totalOccurrences(entry.spec, scheduledFor, nowMs);
      if (missed && entry.missedPolicy === "skip") {
        await this._recordSkip(entry, scheduledFor, total, nowMs, "missed");
        return;
      }
      const trigger: ScheduleRunTrigger = missed ? "recovery" : "scheduled";
      if (missed) entry.missedCount += Math.max(0, total - MAX_SCHEDULE_CATCH_UP);
      await this._emitSchedule(entry, "due", `trigger=${trigger} occurrences=${total}`);
      const busy =
        this._active.has(entry.scheduleId) ||
        this._queued.has(entry.scheduleId) ||
        (await this._hasUnfinished(entry.scheduleId));
      if (busy) {
        if (entry.overlapPolicy === "queue_one") {
          if (!this._queued.has(entry.scheduleId)) {
            this._queued.add(entry.scheduleId);
            // Advance so the timer never hot-loops; the drain launches once.
            entry.nextRunAt = this._advanceNext(entry, scheduledFor, nowMs);
            entry.updatedAt = new Date(nowMs).toISOString();
            await this._persist(entry);
            await this._emitSchedule(entry, "due", `trigger=${trigger} overlap=queue_one`);
          } else {
            await this._recordSkip(entry, scheduledFor, 1, nowMs, "overlap");
          }
          return;
        }
        await this._recordSkip(entry, scheduledFor, 1, nowMs, "overlap");
        return;
      }
      if (this._active.size >= MAX_CONCURRENT_SCHEDULE_RUNS) {
        await this._recordSkip(entry, scheduledFor, 1, nowMs, "concurrency");
        return;
      }
      void this._launch(entry, trigger, scheduledFor, true).catch(() => undefined);
    } catch {
      // Fail closed per-occurrence: never break the timer loop over one row.
    }
  }

  /**
   * Launches one run through the background delegate and settles the run
   * row (completed on handoff, failed when the handoff throws). Never throws
   * for launch outcomes; only storage loss propagates. When advance is true
   * (timer/recovery launches) the schedule's nextRunAt advances; manual runs
   * leave the cadence untouched. Returns the run id.
   */
  private async _launch(
    entry: ScheduleEntry,
    trigger: ScheduleRunTrigger,
    scheduledFor: number,
    advance: boolean,
  ): Promise<string> {
    const id = entry.scheduleId;
    this._active.add(id);
    const runId = createScheduledRunId();
    const startedAt = this._nowMs();
    try {
      // Pre-write prune (keep 49): same-instant ties must never evict the
      // row created below, so room is reserved before the write.
      await this._pruneForWrite(id);
      await this._runs.create({
        runId,
        scheduleId: id,
        projectId: entry.projectId,
        backgroundTaskId: null,
        trigger,
        status: "pending",
        scheduledFor,
        startedAt,
        finishedAt: null,
        error: null,
      });
      await this._runs.update(runId, { status: "running" });
      let backgroundTaskId: string;
      try {
        backgroundTaskId = await this._startBackground(entry);
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : String(err);
        let error =
          err instanceof SchedulerServiceError ? raw : `handoff-failed: ${truncate(raw, 1500)}`;
        try {
          refuseSecrets({ error });
        } catch {
          error = "handoff-failed: background handoff failed (detail withheld)";
        }
        error = truncate(error, MAX_ERROR_LENGTH);
        const finishedAt = this._nowMs();
        await this._runs.update(runId, { status: "failed", finishedAt, error });
        await this._refreshAfterRun(entry, "failed", finishedAt, scheduledFor, advance);
        await this._emitSchedule(entry, "run.failed", `run=${runId} trigger=${trigger}`, runId);
        await this._prune(id);
        return runId;
      }
      const finishedAt = this._nowMs();
      await this._runs.update(runId, {
        backgroundTaskId,
        status: "completed",
        finishedAt,
      });
      await this._refreshAfterRun(entry, "completed", finishedAt, scheduledFor, advance);
      await this._emitSchedule(
        entry,
        "run.started",
        `run=${runId} trigger=${trigger} task=${backgroundTaskId}`,
        runId,
      );
      await this._prune(id);
      return runId;
    } finally {
      this._active.delete(id);
      // Drain a single deferred queue_one launch when still scheduled.
      if (this._queued.delete(id)) {
        const current = this._entries.get(id);
        if (current && current.enabled) {
          const at = this._nowMs();
          void this._launch(current, "scheduled", at, true).catch(() => undefined);
        }
      }
    }
  }

  private async _refreshAfterRun(
    entry: ScheduleEntry,
    status: string,
    atMs: number,
    scheduledFor: number,
    advance: boolean,
  ): Promise<void> {
    entry.lastRunAt = atMs;
    entry.lastRunStatus = status;
    entry.updatedAt = new Date(atMs).toISOString();
    if (status === "completed") entry.runCount += 1;
    if (advance) entry.nextRunAt = this._advanceNext(entry, scheduledFor, atMs);
    await this._persist(entry);
  }

  private async _recordSkip(
    entry: ScheduleEntry,
    scheduledFor: number,
    occurrences: number,
    nowMs: number,
    reason: "missed" | "overlap" | "concurrency",
  ): Promise<void> {
    entry.missedCount += occurrences;
    entry.lastRunAt = nowMs;
    entry.lastRunStatus = "skipped";
    entry.updatedAt = new Date(nowMs).toISOString();
    entry.nextRunAt = this._advanceNext(entry, scheduledFor, nowMs);
    await this._persist(entry);
    const runId = createScheduledRunId();
    const error = `skipped (${reason}): occurrence not launched; next run rescheduled`;
    await this._pruneForWrite(entry.scheduleId);
    await this._runs.create({
      runId,
      scheduleId: entry.scheduleId,
      projectId: entry.projectId,
      backgroundTaskId: null,
      trigger: "scheduled",
      status: "skipped",
      scheduledFor,
      startedAt: nowMs,
      finishedAt: nowMs,
      error,
    });
    await this._emitSchedule(entry, "run.skipped", `run=${runId} reason=${reason}`, runId);
    await this._prune(entry.scheduleId);
  }

  private _advanceNext(entry: ScheduleEntry, scheduledFor: number, nowMs: number): number | null {
    if (entry.spec.kind === "interval") {
      const period = entry.spec.intervalMs;
      const missed = Math.floor(Math.max(0, nowMs - scheduledFor) / period);
      return scheduledFor + (missed + 1) * period;
    }
    if (entry.spec.kind === "daily" || entry.spec.kind === "weekly") {
      return this._computeNext(entry.spec, entry.timezone, nowMs);
    }
    return null;
  }

  /** Hands one prompt to the background delegate with the SAME projectId. */
  private async _startBackground(entry: ScheduleEntry): Promise<string> {
    const delegate = this._background as {
      startTask?: (input: { goal: string; projectId: string }) => Promise<unknown>;
      start?: (input: { projectId: string; goal: string; title: string }) => Promise<unknown>;
    };
    const title = `Scheduled: ${entry.name}`.slice(0, MAX_NAME_LENGTH);
    let result: unknown = null;
    if (typeof delegate.startTask === "function") {
      result = await delegate.startTask({ goal: entry.prompt, projectId: entry.projectId });
    } else if (typeof delegate.start === "function") {
      result = await delegate.start({ projectId: entry.projectId, goal: entry.prompt, title });
    } else {
      throw new SchedulerServiceError(
        "background-unavailable",
        "background task service is not available",
      );
    }
    const taskId = extractTaskId(result);
    if (!taskId) {
      throw new SchedulerServiceError(
        "handoff-failed",
        "background task handoff did not return a task id",
      );
    }
    return taskId;
  }

  private async _hasUnfinished(scheduleId: string): Promise<boolean> {
    try {
      const rows = await this._runs.listUnfinished(scheduleId);
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private async _prune(scheduleId: string): Promise<void> {
    try {
      await this._runs.pruneRuns(scheduleId, MAX_SCHEDULE_RUN_HISTORY);
    } catch {
      // retention is best-effort; the launch already settled
    }
  }

  /** Reserves room before a run write so ties never evict the new row. */
  private async _pruneForWrite(scheduleId: string): Promise<void> {
    try {
      await this._runs.pruneRuns(scheduleId, MAX_SCHEDULE_RUN_HISTORY - 1);
    } catch {
      // retention is best-effort; the write below still proceeds
    }
  }

  private async _readRun(runId: string, entry: ScheduleEntry): Promise<ScheduledRunRow> {
    try {
      const row = await this._runs.get(runId);
      if (row && row.scheduleId === entry.scheduleId) {
        const validated = this._validateRunRow(row);
        if (validated) return validated;
      }
    } catch {
      // fall through to the storage-error below
    }
    throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
  }

  // -------------------------------------------------------------------------
  // Persistence + events
  // -------------------------------------------------------------------------

  private _nowMs(): number {
    return this._clock ? this._clock() : Date.now();
  }

  private _computeNext(spec: ScheduleSpec, timezone: string, fromMs: number): number | null {
    if (this._calculator) {
      const next = this._calculator(spec, timezone, fromMs);
      if (next == null) return null;
      if (!Number.isFinite(next) || next < 0) {
        throw new SchedulerServiceError(
          "storage-error",
          "schedule calculator returned an invalid next run",
        );
      }
      return next;
    }
    return computeScheduleNextRun(spec, timezone, fromMs);
  }

  private async _persist(entry: ScheduleEntry): Promise<void> {
    // Never resurrect a deleted schedule: delete() evicts the cache entry,
    // and in-flight launches observe the eviction here.
    if (!this._entries.has(entry.scheduleId)) return;
    const name = truncate(entry.name, MAX_NAME_LENGTH);
    const prompt = truncate(entry.prompt, MAX_PROMPT_LENGTH);
    const description =
      entry.description === undefined ? null : truncate(entry.description, MAX_DESCRIPTION_LENGTH);
    refuseSecrets({ name, prompt, description });
    const createdMs = Date.parse(entry.createdAt);
    const updatedMs = Date.parse(entry.updatedAt);
    if (!Number.isFinite(createdMs) || !Number.isFinite(updatedMs)) {
      throw new SchedulerServiceError("storage-error", "schedule timestamps are invalid");
    }
    const row: ScheduledTaskRow = {
      scheduleId: entry.scheduleId,
      projectId: entry.projectId,
      name,
      description,
      prompt,
      kind: entry.spec.kind,
      configJson: JSON.stringify(entry.spec),
      timezone: entry.timezone,
      enabled: entry.enabled,
      missedPolicy: entry.missedPolicy,
      overlapPolicy: entry.overlapPolicy,
      createdAt: createdMs,
      updatedAt: updatedMs,
      nextRunAt: entry.nextRunAt,
      lastRunAt: entry.lastRunAt ?? null,
      lastRunStatus: entry.lastRunStatus ?? null,
      runCount: entry.runCount,
      missedCount: entry.missedCount,
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
    };
    try {
      await this._schedules.upsert(row);
    } catch (err) {
      if (err instanceof SchedulerServiceError) throw err;
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
  }

  /** Publishes schedule.* via storage.append then EventBus.publish. */
  private async _emitSchedule(
    entry: Pick<ScheduleEntry, "scheduleId" | "projectId" | "enabled" | "lastRunStatus">,
    type: ScheduleEventType,
    detail?: string,
    runId?: string,
  ): Promise<void> {
    const eventType = scheduleEventType(type);
    let clean: string | undefined;
    if (detail !== undefined) {
      clean = truncate(detail.trim(), 2000);
      if (clean.length > 0) {
        refuseSecrets({ detail: clean });
      } else {
        clean = undefined;
      }
    }
    const conversationId = entry.scheduleId.toUpperCase() as ConversationId;
    const status = entry.lastRunStatus ?? (entry.enabled ? "enabled" : "disabled");
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sequence = await this._allocateSequence(conversationId);
      const event = {
        eventId: createEventId(),
        conversationId,
        sequence,
        schemaVersion: 1,
        timestamp: new Date(this._nowMs()).toISOString(),
        type: eventType,
        category: "extension",
        scheduleId: entry.scheduleId,
        projectId: entry.projectId,
        status,
        ...(runId ? { runId } : {}),
        ...(clean !== undefined ? { detail: clean } : {}),
      } as unknown as AIEvent;
      try {
        await this._storage.append(event);
      } catch {
        // Sequence collision (restart replay racing a live writer): take the
        // next sequence and retry instead of dropping the event.
        this._sequenceCounters.set(conversationId, sequence + 1);
        continue;
      }
      await this._bus.publish(event);
      return;
    }
    throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
  }

  private async _allocateSequence(conversationId: ConversationId): Promise<number> {
    const cached = this._sequenceCounters.get(conversationId);
    if (cached !== undefined) {
      this._sequenceCounters.set(conversationId, cached + 1);
      return cached;
    }
    let base = 0;
    try {
      const existing = await this._storage.getByConversation(conversationId);
      base = existing.length;
    } catch {
      base = 0;
    }
    this._sequenceCounters.set(conversationId, base + 1);
    return base;
  }

  // -------------------------------------------------------------------------
  // Ownership, projection, row validation
  // -------------------------------------------------------------------------

  private async _requireOwned(scheduleId: string, projectId: string): Promise<ScheduleEntry> {
    const id = requireScheduleId(scheduleId);
    const scoped = requireProjectId(projectId);
    const entry = this._entries.get(id) ?? (await this._materialize(id));
    if (!entry) {
      throw new SchedulerServiceError("not-found", "schedule was not found");
    }
    if (entry.projectId !== scoped) {
      throw new SchedulerServiceError(
        "project-mismatch",
        "schedule does not belong to this project",
      );
    }
    return entry;
  }

  private async _materialize(scheduleId: string): Promise<ScheduleEntry | null> {
    let row: ScheduledTaskRow | null;
    try {
      row = await this._schedules.get(scheduleId);
    } catch {
      throw new SchedulerServiceError("storage-error", "schedule storage unavailable");
    }
    if (!row) return null;
    const entry = this._entryFromRow(row);
    if (!entry) {
      throw new SchedulerServiceError("storage-error", "stored schedule is malformed");
    }
    this._entries.set(entry.scheduleId, entry);
    return entry;
  }

  private _entryFromRow(row: ScheduledTaskRow): ScheduleEntry | null {
    const validated = this._validateRow(row);
    if (!validated) return null;
    return validated;
  }

  private _validateRow(row: ScheduledTaskRow): ScheduleEntry | null {
    if (!row || typeof row !== "object") return null;
    if (typeof row.scheduleId !== "string" || !isUlid(row.scheduleId)) return null;
    if (
      typeof row.projectId !== "string" ||
      row.projectId.trim().length === 0 ||
      row.projectId.length > 256
    ) {
      return null;
    }
    if (
      typeof row.name !== "string" ||
      row.name.trim().length === 0 ||
      row.name.length > MAX_NAME_LENGTH
    ) {
      return null;
    }
    if (
      typeof row.prompt !== "string" ||
      row.prompt.trim().length === 0 ||
      row.prompt.length > MAX_PROMPT_LENGTH
    ) {
      return null;
    }
    if (
      row.description != null &&
      (typeof row.description !== "string" || row.description.length > MAX_DESCRIPTION_LENGTH)
    ) {
      return null;
    }
    if (
      row.kind !== "once" &&
      row.kind !== "delay" &&
      row.kind !== "interval" &&
      row.kind !== "daily" &&
      row.kind !== "weekly"
    ) {
      return null;
    }
    let spec: ScheduleSpec;
    try {
      spec = normalizeScheduleSpec(JSON.parse(row.configJson) as unknown);
    } catch {
      return null;
    }
    if (spec.kind !== row.kind) return null;
    try {
      requireTimezone(row.timezone, "UTC");
    } catch {
      return null;
    }
    if (row.missedPolicy !== "skip" && row.missedPolicy !== "run_once") return null;
    if (row.overlapPolicy !== "skip" && row.overlapPolicy !== "queue_one") return null;
    if (typeof row.enabled !== "boolean") return null;
    if (!Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt)) return null;
    if (row.nextRunAt != null && !Number.isFinite(row.nextRunAt)) return null;
    if (row.lastRunAt != null && !Number.isFinite(row.lastRunAt)) return null;
    if (row.lastRunStatus != null && typeof row.lastRunStatus !== "string") return null;
    if (!Number.isInteger(row.runCount) || row.runCount < 0) return null;
    if (!Number.isInteger(row.missedCount) || row.missedCount < 0) return null;
    if (row.schemaVersion !== SCHEDULE_SCHEMA_VERSION) return null;
    const createdAt = new Date(row.createdAt).toISOString();
    const updatedAt = new Date(row.updatedAt).toISOString();
    if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) return null;
    return {
      scheduleId: row.scheduleId.toUpperCase(),
      projectId: row.projectId,
      name: row.name,
      ...(row.description != null ? { description: row.description } : {}),
      prompt: row.prompt,
      spec,
      timezone: row.timezone,
      enabled: row.enabled,
      missedPolicy: row.missedPolicy,
      overlapPolicy: row.overlapPolicy,
      createdAt,
      updatedAt,
      nextRunAt: row.nextRunAt ?? null,
      ...(row.lastRunAt != null ? { lastRunAt: row.lastRunAt } : {}),
      ...(row.lastRunStatus != null ? { lastRunStatus: row.lastRunStatus } : {}),
      runCount: row.runCount,
      missedCount: row.missedCount,
    };
  }

  private _validateRunRow(row: ScheduledRunRow): ScheduledRunRow | null {
    if (!row || typeof row !== "object") return null;
    if (typeof row.runId !== "string" || row.runId.trim().length === 0) return null;
    if (typeof row.scheduleId !== "string" || !isUlid(row.scheduleId)) return null;
    if (
      typeof row.projectId !== "string" ||
      row.projectId.trim().length === 0 ||
      row.projectId.length > 256
    ) {
      return null;
    }
    const statuses = new Set(["pending", "running", "completed", "failed", "skipped", "cancelled"]);
    if (typeof row.status !== "string" || !statuses.has(row.status)) return null;
    const triggers = new Set(["scheduled", "manual", "recovery"]);
    const trigger =
      typeof row.trigger === "string" && triggers.has(row.trigger) ? row.trigger : "scheduled";
    if (!Number.isFinite(row.scheduledFor)) return null;
    if (row.startedAt != null && !Number.isFinite(row.startedAt)) return null;
    if (row.finishedAt != null && !Number.isFinite(row.finishedAt)) return null;
    if (
      row.error != null &&
      (typeof row.error !== "string" || row.error.length > MAX_ERROR_LENGTH)
    ) {
      return null;
    }
    if (row.backgroundTaskId != null && typeof row.backgroundTaskId !== "string") return null;
    return { ...row, trigger };
  }

  private _project(entry: ScheduleEntry): ScheduleProjection {
    return {
      scheduleId: entry.scheduleId,
      projectId: entry.projectId,
      name: entry.name,
      ...(entry.description !== undefined
        ? { description: entry.description, scheduleDescription: entry.description }
        : {}),
      prompt: entry.prompt,
      schedule: { ...entry.spec },
      timezone: entry.timezone,
      enabled: entry.enabled,
      missedPolicy: entry.missedPolicy,
      overlapPolicy: entry.overlapPolicy,
      overlap: entry.overlapPolicy === "queue_one" ? "queue" : "skip",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      nextRunAt: entry.nextRunAt == null ? null : new Date(entry.nextRunAt).toISOString(),
      ...(entry.lastRunAt !== undefined
        ? { lastRunAt: new Date(entry.lastRunAt).toISOString() }
        : {}),
      ...(entry.lastRunStatus !== undefined ? { lastRunStatus: entry.lastRunStatus } : {}),
      runCount: entry.runCount,
      missedCount: entry.missedCount,
    };
  }

  private _projectRun(row: ScheduledRunRow, projectId: string): ScheduledRunProjection {
    const scheduledFor = new Date(row.scheduledFor).toISOString();
    return {
      runId: row.runId,
      scheduleId: row.scheduleId,
      projectId,
      ...(row.backgroundTaskId != null
        ? { backgroundTaskId: row.backgroundTaskId, taskId: row.backgroundTaskId }
        : {}),
      trigger: (row.trigger === "manual" || row.trigger === "recovery"
        ? row.trigger
        : "scheduled") as ScheduleRunTrigger,
      status: row.status,
      scheduledFor,
      createdAt: row.startedAt != null ? new Date(row.startedAt).toISOString() : scheduledFor,
      ...(row.startedAt != null ? { startedAt: new Date(row.startedAt).toISOString() } : {}),
      ...(row.finishedAt != null ? { finishedAt: new Date(row.finishedAt).toISOString() } : {}),
      ...(row.error != null ? { error: row.error, errorSnippet: row.error.slice(0, 500) } : {}),
    };
  }
}
