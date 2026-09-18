// PR44: packages/ai-core — Scheduled & Autonomous Task Contracts (CONTRACTS layer)
//
// Pure domain contracts for user-defined schedules that autonomously launch
// background tasks: schedule kinds + per-kind config bounds, run identity and
// lifecycle, caps, timezone validation, event names, error taxonomy, and a
// creation-time input validator.
//
// Dependency rule:
//   ai-core -> shared (ai-core may ONLY depend on @ai-desktop/shared)
//
// Zero Electron, Prisma, child process spawn, filesystem, or network imports.
// NO runtime logic here: no scheduler, timer, launcher, or persistence writer.
// Caps and policies below are enforced by the agent-runtime scheduler layer,
// never by these schemas.
//
// Canonical PR44 design decisions (implemented exactly; do not drift):
//   1. NO cron expressions (explicit non-goal). Kinds are `once { runAt }`,
//      `delay { delayMs }` (converted to runAt at creation), `interval
//      { everyMs }`, `daily { hour, minute }`, and `weekly { weekday 0-6,
//      hour, minute }`. Rationale: no new dependencies, a tiny validation
//      surface, and coverage of every required example.
//   2. Limits: MAX_SCHEDULES_TOTAL=32, MAX_SCHEDULES_PER_PROJECT=8,
//      MIN_INTERVAL_MS=60_000 (a `every 1 second` schedule is rejected; the
//      validator/calculator accept an options-param override for tests only,
//      never via persisted data), MAX_RUNS_PER_SCHEDULE=50 (oldest pruned),
//      MAX_CATCH_UP_RUNS=1.
//   3. Missed-run policy per schedule: `missedPolicy: "skip" | "run_once"`;
//      default "skip" for recurring (interval/daily/weekly), default
//      "run_once" for once/delay. Catch-up never exceeds 1 run; excess
//      occurrences collapse into missedCount.
//   4. Overlap policy per schedule: `overlapPolicy: "skip" | "queue_one"`;
//      default "skip". An active run (launched, not yet settled) plus a newly
//      due occurrence either skips (emits run.skipped) or parks exactly one
//      queued occurrence (queue_one); never more than one pending.
//   5. Run identity: runId is a ULID distinct from scheduleId and
//      backgroundTaskId. Trigger is "scheduled" | "manual" | "recovery". Run
//      statuses are pending/running/completed/failed/skipped/cancelled.
//   6. Timezone: a persisted IANA `timezone` string per schedule (default
//      "UTC"), validated via Intl (supportedValuesOf when available, else a
//      trial DateTimeFormat construction); invalid values are
//      validation-errors. Daily/weekly wall-clock resolution lives in the
//      scheduler calculator; system-tz changes are irrelevant because the tz
//      is persisted on the record.
//   7. Scheduler tick: a single timer only. The scheduler never calls tools,
//      shell, fs, or network; it launches through an injected delegate.
//   8. Exactly-once: a durable run record is created (pending) BEFORE launch;
//      launch failure marks the run failed (no scheduler-level retry).
//      Startup recovery validates, dedupes, and recomputes nextRunAt from
//      persisted timestamps (never trusting a stale nextRunAt blindly).
//   9. Security: assertNoSecrets-equivalent guard on name/prompt/description
//      (reuses assertNoSecrets from background-tasks.js); name<=120,
//      prompt<=4000, description<=2000, error<=2000; projectId is immutable
//      per schedule; cross-project ops are project-mismatch; malformed ids
//      are validation-error; unknown ids are not-found.
//  10. Permissions: the scheduler auto-approves NOTHING. Launched tasks flow
//      through BackgroundTaskManager -> PermissionManager and may park in
//      waiting_permission. Schedule existence is never a permission grant.

import { z } from "zod";
import {
  TaskIdSchema,
  TimestampStringSchema,
  generateUlid,
  isUlid,
  type Brand,
} from "@ai-desktop/shared";
import { assertNoSecrets } from "./background-tasks.js";

// ---------------------------------------------------------------------------
// Branded Schedule / Run Identifiers
//
// Schedules need their own branded ids (never reuse TaskId across entities).
// Defined here rather than in identifiers.ts to keep this PR's ownership to
// the files listed in the PR44 contract; the pattern mirrors identifiers.ts.
// ---------------------------------------------------------------------------

export type ScheduleId = Brand<string, "ScheduleId">;
export type ScheduledRunId = Brand<string, "ScheduledRunId">;

const ULID_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;

const UlidSchema = z.string().trim().regex(ULID_PATTERN, {
  message: "Value must be a valid 26-character Crockford Base32 ULID",
});

export const ScheduleIdSchema = UlidSchema.transform((val) => val.toUpperCase() as ScheduleId);
export const ScheduledRunIdSchema = UlidSchema.transform(
  (val) => val.toUpperCase() as ScheduledRunId,
);

export function createScheduleId(seedTime?: number): ScheduleId {
  return generateUlid(seedTime) as ScheduleId;
}

export function createScheduledRunId(seedTime?: number): ScheduledRunId {
  return generateUlid(seedTime) as ScheduledRunId;
}

export function parseScheduleId(raw: string): ScheduleId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid ScheduleId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as ScheduleId;
}

export function parseScheduledRunId(raw: string): ScheduledRunId {
  if (!isUlid(raw)) {
    throw new TypeError(`Invalid ScheduledRunId: "${raw}" is not a valid ULID`);
  }
  return raw.toUpperCase() as ScheduledRunId;
}

export function asScheduleId(raw: string): ScheduleId {
  return raw as ScheduleId;
}

export function asScheduledRunId(raw: string): ScheduledRunId {
  return raw as ScheduledRunId;
}

// ---------------------------------------------------------------------------
// Schedule Kinds + Per-Kind Config Schemas (decision 1: no cron)
// ---------------------------------------------------------------------------

export const ScheduleKindSchema = z.enum(["once", "delay", "interval", "daily", "weekly"]);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

// Bounds for delayMs/everyMs: structurally any positive int is well-formed;
// the MIN_INTERVAL_MS floor is enforced by validateScheduleInput() and the
// scheduler calculator (both accept a test-only options override), never by
// persisted-record parsing, so stored records always re-validate.
export const MAX_DELAY_MS = 365 * 24 * 3600 * 1000; // 1 year in ms: 31_536_000_000

export const OnceConfigSchema = z
  .object({
    runAt: TimestampStringSchema,
  })
  .strict();
export type OnceConfig = z.infer<typeof OnceConfigSchema>;

export const DelayConfigSchema = z
  .object({
    delayMs: z.number().int().min(1).max(MAX_DELAY_MS),
  })
  .strict();
export type DelayConfig = z.infer<typeof DelayConfigSchema>;

export const IntervalConfigSchema = z
  .object({
    everyMs: z.number().int().min(1).max(MAX_DELAY_MS),
  })
  .strict();
export type IntervalConfig = z.infer<typeof IntervalConfigSchema>;

export const DailyConfigSchema = z
  .object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();
export type DailyConfig = z.infer<typeof DailyConfigSchema>;

export const WeeklyConfigSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  })
  .strict();
export type WeeklyConfig = z.infer<typeof WeeklyConfigSchema>;

// Strict members + weekly-before-daily ordering: zod object schemas strip
// unknown keys by default, so without .strict() a weekly config would also
// match DailyConfigSchema and lose `weekday`. Strictness keeps the union
// disjoint; the kind<->config cross-check below rejects mismatched pairs.
export const ScheduleConfigSchema = z.union([
  OnceConfigSchema,
  DelayConfigSchema,
  IntervalConfigSchema,
  WeeklyConfigSchema,
  DailyConfigSchema,
]);
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

/** Structural check that a config object belongs to the declared kind. */
export function configMatchesKind(kind: ScheduleKind, config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  const c = config as Record<string, unknown>;
  switch (kind) {
    case "once":
      return typeof c.runAt === "string";
    case "delay":
      return typeof c.delayMs === "number";
    case "interval":
      return typeof c.everyMs === "number";
    case "daily":
      return (
        typeof c.hour === "number" &&
        typeof c.minute === "number" &&
        !("weekday" in c) &&
        !("runAt" in c) &&
        !("delayMs" in c) &&
        !("everyMs" in c)
      );
    case "weekly":
      return (
        typeof c.weekday === "number" && typeof c.hour === "number" && typeof c.minute === "number"
      );
  }
}

// ---------------------------------------------------------------------------
// Policies, Triggers, Run Statuses (decisions 3-5)
// ---------------------------------------------------------------------------

export const MissedPolicySchema = z.enum(["skip", "run_once"]);
export type MissedPolicy = z.infer<typeof MissedPolicySchema>;

export const OverlapPolicySchema = z.enum(["skip", "queue_one"]);
export type OverlapPolicy = z.infer<typeof OverlapPolicySchema>;

export const TriggerSchema = z.enum(["scheduled", "manual", "recovery"]);
export type ScheduleTrigger = z.infer<typeof TriggerSchema>;

export const ScheduledRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type ScheduledRunStatus = z.infer<typeof ScheduledRunStatusSchema>;

/** Default missed policy per kind (decision 3). */
export function defaultMissedPolicyForKind(kind: ScheduleKind): MissedPolicy {
  return kind === "once" || kind === "delay" ? "run_once" : "skip";
}

// ---------------------------------------------------------------------------
// Caps + Text Bounds (decision 2, bounds mirror background-tasks.ts)
// ---------------------------------------------------------------------------

export const MAX_SCHEDULES_TOTAL = 32;
export const MAX_SCHEDULES_PER_PROJECT = 8;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_RUNS_PER_SCHEDULE = 50;
export const MAX_CATCH_UP_RUNS = 1;
export const MAX_SCHEDULE_NAME_LENGTH = 120;
export const MAX_SCHEDULE_PROMPT_LENGTH = 4000;
export const MAX_SCHEDULE_DESCRIPTION_LENGTH = 2000;
export const MAX_SCHEDULE_ERROR_LENGTH = 2000;
export const SCHEDULER_TICK_MS_DEFAULT = 30_000;

// ---------------------------------------------------------------------------
// Timezone Validation (decision 6: Intl only, no date library)
// ---------------------------------------------------------------------------

/**
 * Validates an IANA timezone string using built-in Intl only. Accepts the
 * value when Intl.supportedValuesOf('timeZone') lists it OR when trial
 * DateTimeFormat construction succeeds. Both checks are needed: some ICU
 * builds omit valid aliases/links (e.g. "UTC", "Asia/Kolkata") from
 * supportedValuesOf while DateTimeFormat still resolves them, and trial
 * construction is what the scheduler calculator actually relies on. Never
 * throws.
 */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string") return false;
  const tz = timezone.trim();
  if (tz.length === 0 || tz.length > 128) return false;
  try {
    const intlWithSupport = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    if (typeof intlWithSupport.supportedValuesOf === "function") {
      if (intlWithSupport.supportedValuesOf("timeZone").includes(tz)) return true;
    }
  } catch {
    // Fall through to trial construction below.
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((val) => isValidTimezone(val), {
    message: 'Timezone must be a valid IANA timezone name (e.g. "UTC", "Asia/Kolkata")',
  });

// ---------------------------------------------------------------------------
// Durable Schedule Record / Run Record
// ---------------------------------------------------------------------------

export const ScheduledTaskRecordSchema = z.object({
  id: ScheduleIdSchema,
  projectId: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_LENGTH),
  description: z.string().trim().max(MAX_SCHEDULE_DESCRIPTION_LENGTH).optional(),
  prompt: z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT_LENGTH),
  kind: ScheduleKindSchema,
  config: ScheduleConfigSchema,
  timezone: TimezoneSchema,
  enabled: z.boolean(),
  missedPolicy: MissedPolicySchema,
  overlapPolicy: OverlapPolicySchema,
  createdAt: TimestampStringSchema,
  updatedAt: TimestampStringSchema,
  nextRunAt: TimestampStringSchema,
  lastRunAt: TimestampStringSchema.optional(),
  lastRunStatus: ScheduledRunStatusSchema.optional(),
  runCount: z.number().int().min(0),
  missedCount: z.number().int().min(0),
  schemaVersion: z.literal(1),
});
export type ScheduledTaskRecord = z.infer<typeof ScheduledTaskRecordSchema>;

export const ScheduledRunRecordSchema = z.object({
  runId: ScheduledRunIdSchema,
  scheduleId: ScheduleIdSchema,
  projectId: z.string().trim().min(1).max(256),
  backgroundTaskId: TaskIdSchema.optional(),
  trigger: TriggerSchema,
  status: ScheduledRunStatusSchema,
  scheduledFor: TimestampStringSchema,
  startedAt: TimestampStringSchema.optional(),
  finishedAt: TimestampStringSchema.optional(),
  error: z.string().max(MAX_SCHEDULE_ERROR_LENGTH).optional(),
});
export type ScheduledRunRecord = z.infer<typeof ScheduledRunRecordSchema>;

// ---------------------------------------------------------------------------
// Creation-Time Input Validation (throws ZodError on any violation)
// ---------------------------------------------------------------------------

export interface ValidateScheduleInputOptions {
  /**
   * Test-only override for the MIN_INTERVAL_MS floor applied to
   * delayMs/everyMs. Never sourced from persisted data.
   */
  readonly minIntervalMs?: number;
}

function addScheduleInputRefinements(
  schema: z.ZodObject<
    {
      projectId: z.ZodString;
      name: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      prompt: z.ZodString;
      kind: typeof ScheduleKindSchema;
      config: typeof ScheduleConfigSchema;
      timezone: z.ZodOptional<typeof TimezoneSchema>;
      enabled: z.ZodOptional<z.ZodBoolean>;
      missedPolicy: z.ZodOptional<typeof MissedPolicySchema>;
      overlapPolicy: z.ZodOptional<typeof OverlapPolicySchema>;
    },
    z.core.$strip
  >,
  minIntervalMs: number,
) {
  return schema.superRefine((val, ctx) => {
    if (!configMatchesKind(val.kind, val.config)) {
      ctx.addIssue({
        code: "custom",
        message: `Schedule config does not match kind "${val.kind}"`,
        path: ["config"],
      });
    }
    if (val.kind === "delay" || val.kind === "interval") {
      const ms =
        val.kind === "delay"
          ? (val.config as { delayMs?: unknown }).delayMs
          : (val.config as { everyMs?: unknown }).everyMs;
      if (typeof ms === "number" && ms < minIntervalMs) {
        ctx.addIssue({
          code: "custom",
          message: `Schedule interval must be at least ${minIntervalMs}ms (got ${ms}ms)`,
          path: ["config"],
        });
      }
    }
    try {
      assertNoSecrets(val.prompt);
      assertNoSecrets(val.name);
      if (val.description !== undefined) assertNoSecrets(val.description);
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "secret-refused: schedule text appears to contain secret material; store a secure reference instead",
        path: ["prompt"],
      });
    }
  });
}

function createScheduleInputSchema(minIntervalMs: number) {
  return addScheduleInputRefinements(
    z.object({
      projectId: z.string().trim().min(1).max(256),
      name: z.string().trim().min(1).max(MAX_SCHEDULE_NAME_LENGTH),
      description: z.string().trim().max(MAX_SCHEDULE_DESCRIPTION_LENGTH).optional(),
      prompt: z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT_LENGTH),
      kind: ScheduleKindSchema,
      config: ScheduleConfigSchema,
      timezone: TimezoneSchema.optional(),
      enabled: z.boolean().optional(),
      missedPolicy: MissedPolicySchema.optional(),
      overlapPolicy: OverlapPolicySchema.optional(),
    }),
    minIntervalMs,
  );
}

/** Creation-time input schema with the production MIN_INTERVAL_MS floor. */
export const ScheduleInputSchema = createScheduleInputSchema(MIN_INTERVAL_MS);
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

/**
 * Fully-resolved creation input: every optional (timezone, enabled,
 * missedPolicy, overlapPolicy) filled with its documented default.
 */
export interface ValidatedScheduleInput {
  readonly projectId: string;
  readonly name: string;
  readonly description?: string;
  readonly prompt: string;
  readonly kind: ScheduleKind;
  readonly config: ScheduleConfig;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly missedPolicy: MissedPolicy;
  readonly overlapPolicy: OverlapPolicy;
}

/**
 * Validates raw schedule-creation input and returns it with defaults applied
 * (timezone "UTC", enabled true, kind-appropriate missedPolicy, overlap
 * "skip"). Throws a ZodError covering: schema violations, kind/config
 * mismatch, sub-MIN_INTERVAL_MS delayMs/everyMs, invalid timezone, and
 * secret-bearing name/prompt/description (surfaced as a secret-refused
 * issue, never echoing the value).
 */
export function validateScheduleInput(
  input: unknown,
  options?: ValidateScheduleInputOptions,
): ValidatedScheduleInput {
  const minIntervalMs = options?.minIntervalMs ?? MIN_INTERVAL_MS;
  const parsed = createScheduleInputSchema(minIntervalMs).parse(input);
  return {
    projectId: parsed.projectId,
    name: parsed.name,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    prompt: parsed.prompt,
    kind: parsed.kind,
    config: parsed.config,
    timezone: parsed.timezone ?? "UTC",
    enabled: parsed.enabled ?? true,
    missedPolicy: parsed.missedPolicy ?? defaultMissedPolicyForKind(parsed.kind),
    overlapPolicy: parsed.overlapPolicy ?? "skip",
  };
}

/**
 * The only meaningful schedule "transition" is the enabled boolean toggle.
 * Any actual flip is legal; a no-op set is not a transition.
 */
export function isLegalScheduleTransition(fromEnabled: boolean, toEnabled: boolean): boolean {
  return fromEnabled !== toEnabled;
}

// ---------------------------------------------------------------------------
// Error Taxonomy (decision 9)
// ---------------------------------------------------------------------------

export const ScheduleErrorCodeSchema = z.enum([
  "not-found",
  "project-mismatch",
  "validation-error",
  "secret-refused",
  "schedule-limit",
  "task-active",
  "storage-error",
]);
export type ScheduleErrorCode = z.infer<typeof ScheduleErrorCodeSchema>;

export interface ScheduleError {
  readonly code: ScheduleErrorCode;
  readonly message: string;
}

export function toScheduleError(code: ScheduleErrorCode, message: string): ScheduleError {
  return { code: ScheduleErrorCodeSchema.parse(code), message };
}

// ---------------------------------------------------------------------------
// Schedule Event Names (`schedule.*`, runs nested as `schedule.run.*`)
// ---------------------------------------------------------------------------

export const SCHEDULE_EVENT_TYPES = [
  "created",
  "updated",
  "enabled",
  "disabled",
  "deleted",
  "due",
  "run.started",
  "run.completed",
  "run.failed",
  "run.skipped",
  "run.recovered",
] as const;
export type ScheduleEventType = (typeof SCHEDULE_EVENT_TYPES)[number];

export const ScheduleEventTypeSchema = z.enum(SCHEDULE_EVENT_TYPES);

/**
 * Builds a `schedule.<type>` event name (`schedule.run.*` for run types),
 * rejecting anything outside the allowlist so producers cannot invent
 * ad-hoc event types. Mirrors backgroundEventType.
 */
export function scheduleEventType(type: string): `schedule.${ScheduleEventType}` {
  if (!(SCHEDULE_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid schedule event type: "${type}"`);
  }
  return `schedule.${type as ScheduleEventType}`;
}
