// PR44: renderer — Schedules bridge + pure view helpers
//
// Narrow, renderer-safe access to the schedule IPC owned by the sibling
// agent (`window.api.schedules.{list,get,create,update,enable,disable,
// delete,runNow,runs}`). The bridge is probed with optional chaining: when
// the sibling IPC has not landed yet (or on non-Electron hosts / tests
// without `window`), every accessor yields an empty result — never a crash —
// and `createLocalScheduleStub` provides an in-memory stand-in so the
// Schedule Center renders and the store/projection tests pass.
//
// Invariants:
//   1. Projections only: the renderer never touches runtime internals,
//      Node or Electron APIs, spawned processes, Prisma, or the DOM bridge
//      beyond `window.api`. Data arrives as `ScheduleView`-shaped views and
//      leaves as narrow calls.
//   2. The renderer holds no source of truth: state re-queries the bridge
//      on mount / poll / scope change, so remounts and disconnects recover
//      by re-fetching.
//   3. Isolation is display-level: filtering by project never rewrites a
//      schedule's bound `projectId`; rows always render the bound id. The
//      project choice is locked per schedule: editing never re-scopes it,
//      and switching workspace projects never rewrites it.
//   4. Hygiene at render: names ≤120, prompts ≤4000 chars;
//      `key=value`-shaped secret material is redacted, never rendered raw.
//   5. Nothing executes from a partial form: create/update bridge calls fire
//      only after `validateScheduleForm` reports zero errors.

// ---------------------------------------------------------------------------
// Vocabulary (canonical: ai-core schedules.ts — no cron; five kinds)
// ---------------------------------------------------------------------------

/** Schedule recurrence kinds. No cron: one-shot, delayed, interval, daily/weekly wall time. */
export const SCHEDULE_KINDS = ["once", "delay", "interval", "daily", "weekly"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** What to do when a tick fires while the previous run is still active. Default: skip. */
export const OVERLAP_POLICIES = ["skip", "queue", "queue_one"] as const;
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number];

/**
 * Display-normalized overlap policy. Canonical `queue_one` renders as the
 * UI's `queue` label; the bridge always sends `overlapPolicy: queue_one`.
 */
export type DisplayOverlapPolicy = "skip" | "queue";

export function toDisplayOverlapPolicy(value: string): DisplayOverlapPolicy {
  return value === "queue" || value === "queue_one" ? "queue" : "skip";
}

export function toCanonicalOverlapPolicy(value: string): "skip" | "queue_one" {
  return value === "queue" || value === "queue_one" ? "queue_one" : "skip";
}

/** What to do with ticks missed while the app was down. Default: skip. */
export const MISSED_POLICIES = ["skip", "run_once"] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];

/** Canonical run statuses (ai-core ScheduledRunStatusSchema). */
export const SCHEDULE_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

/** Canonical run triggers. `recovered` is accepted as a legacy variant of `recovery`. */
export const SCHEDULE_RUN_TRIGGERS = ["scheduled", "manual", "recovery"] as const;
export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return typeof value === "string" && (SCHEDULE_KINDS as readonly string[]).includes(value);
}

export function isOverlapPolicy(value: unknown): value is OverlapPolicy {
  return typeof value === "string" && (OVERLAP_POLICIES as readonly string[]).includes(value);
}

export function isMissedPolicy(value: unknown): value is MissedPolicy {
  return typeof value === "string" && (MISSED_POLICIES as readonly string[]).includes(value);
}

export function isScheduleRunStatus(value: unknown): value is ScheduleRunStatus {
  return typeof value === "string" && (SCHEDULE_RUN_STATUSES as readonly string[]).includes(value);
}

export function isScheduleRunTrigger(value: unknown): value is ScheduleRunTrigger {
  return typeof value === "string" && (SCHEDULE_RUN_TRIGGERS as readonly string[]).includes(value);
}

/** Maps legacy/alternate trigger spellings to canonical triggers. */
export function canonicalScheduleRunTrigger(value: unknown): ScheduleRunTrigger {
  if (value === "recovered") return "recovery";
  return isScheduleRunTrigger(value) ? value : "scheduled";
}

// ---------------------------------------------------------------------------
// Caps (renderer mirrors; enforcement lives main-side)
// ---------------------------------------------------------------------------

/** Maximum schedules retained (workspace-wide; main-side enforcement). */
export const MAX_SCHEDULES_TOTAL = 32;
/** Maximum schedule-triggered runs concurrently active (shared with background caps). */
export const MAX_CONCURRENT_SCHEDULE_RUNS = 8;
/** Minimum interval between recurring ticks (1 minute; sub-minute rejected). */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
/** Maximum missed ticks caught up after downtime (1; the rest skip). */
export const MAX_SCHEDULE_CATCH_UP = 1;
/** Maximum rows rendered per section; the list itself stays bounded. */
export const MAX_SCHEDULE_ROWS_PER_SECTION = 50;
/** Maximum run-history rows rendered in the detail view. */
export const MAX_SCHEDULE_RUNS_SHOWN = 50;
/** Render hygiene bounds (mirror background-tasks.ts truncation discipline). */
export const MAX_SCHEDULE_DISPLAY_NAME = 120;
export const MAX_SCHEDULE_DISPLAY_PROMPT = 4000;

// ---------------------------------------------------------------------------
// Renderer-safe views (projection subsets; secrets never carried)
// ---------------------------------------------------------------------------

export interface ScheduleConfig {
  readonly kind: ScheduleKind;
  readonly intervalMs?: number;
  readonly delayMs?: number;
  readonly runAt?: string;
  readonly dailyTime?: string;
  readonly weekday?: number;
  readonly hour?: number;
  readonly minute?: number;
}

export interface ScheduleView {
  readonly scheduleId: string;
  readonly projectId: string;
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly schedule: ScheduleConfig;
  readonly scheduleDescription?: string;
  readonly overlap: OverlapPolicy;
  readonly missedPolicy: MissedPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastRunStatus?: string;
}

export interface ScheduleRunView {
  readonly runId: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly status: ScheduleRunStatus;
  readonly trigger: ScheduleRunTrigger;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorSnippet?: string;
  readonly taskId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeScheduleConfig(raw: unknown): ScheduleConfig | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (!isScheduleKind(kind)) return null;
  if (kind === "interval") {
    const intervalMs =
      typeof raw.intervalMs === "number" && Number.isFinite(raw.intervalMs)
        ? Math.floor(raw.intervalMs)
        : asOptionalPositiveInt(raw.everyMs);
    if (typeof intervalMs !== "number" || intervalMs < MIN_SCHEDULE_INTERVAL_MS) return null;
    return { kind, intervalMs };
  }
  if (kind === "delay") {
    const delayMs =
      typeof raw.delayMs === "number" && Number.isFinite(raw.delayMs)
        ? Math.floor(raw.delayMs)
        : undefined;
    if (typeof delayMs !== "number" || delayMs < MIN_SCHEDULE_INTERVAL_MS) return null;
    return { kind, delayMs };
  }
  if (kind === "once") {
    const runAt = asOptionalString(raw.runAt ?? raw.at);
    if (!runAt || Number.isNaN(Date.parse(runAt))) return null;
    return { kind, runAt };
  }
  if (kind === "weekly") {
    const weekday = typeof raw.weekday === "number" ? raw.weekday : undefined;
    const hour = typeof raw.hour === "number" ? raw.hour : undefined;
    const minute = typeof raw.minute === "number" ? raw.minute : undefined;
    if (
      weekday === undefined ||
      !Number.isInteger(weekday) ||
      weekday < 0 ||
      weekday > 6 ||
      hour === undefined ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      minute === undefined ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    return { kind, weekday, hour, minute };
  }
  const dailyTime = asOptionalString(raw.dailyTime ?? raw.time);
  if (!dailyTime || !/^\d{2}:\d{2}$/.test(dailyTime)) return null;
  const [hh, mm] = dailyTime.split(":").map(Number);
  if (hh > 23 || mm > 59) return null;
  return { kind, dailyTime };
}

/**
 * Validates one unknown entry into a ScheduleView, or null when unusable.
 * Accepts sibling spelling variants (name/title, prompt/description/goal,
 * timezone/timeZone, missedPolicy/missedRunPolicy) so the surface activates
 * with no renderer change once the sibling IPC lands.
 */
export function normalizeScheduleView(item: unknown): ScheduleView | null {
  if (!isRecord(item)) return null;
  const scheduleId = asNonEmptyString(item.scheduleId ?? item.id);
  if (!scheduleId) return null;
  const projectId = asNonEmptyString(item.projectId);
  if (!projectId) return null;
  const name = asNonEmptyString(item.name ?? item.title);
  if (!name) return null;
  const promptRaw = asOptionalString(item.prompt ?? item.description ?? item.goal) ?? "";
  const createdAt = asOptionalString(item.createdAt);
  const updatedAt = asOptionalString(item.updatedAt);
  if (!createdAt || !updatedAt) return null;
  if (typeof item.enabled !== "boolean") return null;
  const timezone = asOptionalString(item.timezone ?? item.timeZone) ?? "UTC";
  const configRaw = isRecord(item.schedule) ? item.schedule : item;
  const schedule = normalizeScheduleConfig(configRaw);
  if (!schedule) return null;
  const overlapRaw = item.overlap ?? item.overlapPolicy;
  const overlap: OverlapPolicy = isOverlapPolicy(overlapRaw)
    ? (overlapRaw as OverlapPolicy)
    : "skip";
  const missedRaw = item.missedPolicy ?? item.missedRunPolicy;
  const missedPolicy: MissedPolicy = isMissedPolicy(missedRaw) ? missedRaw : "skip";
  return {
    scheduleId,
    projectId,
    name,
    prompt: promptRaw,
    enabled: item.enabled,
    timezone,
    schedule,
    scheduleDescription: asOptionalString(item.scheduleDescription ?? item.description_),
    overlap,
    missedPolicy,
    createdAt,
    updatedAt,
    nextRunAt: asOptionalString(item.nextRunAt ?? item.nextRun),
    lastRunAt: asOptionalString(item.lastRunAt ?? item.previousRunAt ?? item.lastRun),
    lastRunStatus: asOptionalString(item.lastRunStatus ?? item.lastStatus),
  };
}

/** Normalizes a candidate list, dropping entries that fail validation. */
export function normalizeScheduleViews(items: readonly unknown[]): ScheduleView[] {
  const views: ScheduleView[] = [];
  for (const item of items) {
    const view = normalizeScheduleView(item);
    if (view) views.push(view);
  }
  return views;
}

/**
 * Validates one unknown entry into a ScheduleRunView, or null when
 * unusable. Accepts spelling variants (runId/id, finishedAt/completedAt/
 * endedAt) and defaults a missing trigger to `scheduled`.
 */
export function normalizeScheduleRunView(item: unknown): ScheduleRunView | null {
  if (!isRecord(item)) return null;
  const runId = asNonEmptyString(item.runId ?? item.id);
  if (!runId) return null;
  const scheduleId = asNonEmptyString(item.scheduleId);
  if (!scheduleId) return null;
  const projectId = asNonEmptyString(item.projectId);
  if (!projectId) return null;
  if (!isScheduleRunStatus(item.status)) return null;
  const trigger = canonicalScheduleRunTrigger(item.trigger);
  return {
    runId,
    scheduleId,
    projectId,
    status: item.status,
    trigger,
    createdAt: asOptionalString(item.createdAt),
    startedAt: asOptionalString(item.startedAt),
    finishedAt: asOptionalString(item.finishedAt ?? item.completedAt ?? item.endedAt),
    errorSnippet: asOptionalString(item.errorSnippet ?? item.lastError ?? item.error),
    taskId: asOptionalString(item.taskId),
  };
}

/** Normalizes a candidate run list, dropping entries that fail validation. */
export function normalizeScheduleRunViews(items: readonly unknown[]): ScheduleRunView[] {
  const views: ScheduleRunView[] = [];
  for (const item of items) {
    const view = normalizeScheduleRunView(item);
    if (view) views.push(view);
  }
  return views;
}

function unwrapEnvelope(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.ok === true && "value" in raw) return raw.value;
  return raw;
}

/**
 * Accepts the list envelope (`{ ok, value: { schedules } }` /
 * `{ ok, value: [...] }`) or a raw array, and returns candidate entries.
 * Anything else yields [].
 */
export function unwrapScheduleList(raw: unknown): unknown[] {
  const value = unwrapEnvelope(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.schedules)) return value.schedules;
  return [];
}

/** Accepts the get envelope (`{ ok, value: { schedule } }`) or a raw projection. */
export function unwrapSchedule(raw: unknown): unknown {
  const value = unwrapEnvelope(raw);
  if (isRecord(value) && "schedule" in value) return value.schedule;
  return value;
}

/**
 * Accepts the runs envelope (`{ ok, value: { runs } }` /
 * `{ ok, value: [...] }`) or a raw array. Anything else yields [].
 */
export function unwrapScheduleRuns(raw: unknown): unknown[] {
  const value = unwrapEnvelope(raw);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.runs)) return value.runs;
  return [];
}

// ---------------------------------------------------------------------------
// Grouping / filtering (pure; never mutates the bound projectId)
// ---------------------------------------------------------------------------

export interface GroupedSchedules {
  readonly enabled: ScheduleView[];
  readonly disabled: ScheduleView[];
}

function compareNextRunAsc(a: ScheduleView, b: ScheduleView): number {
  const aMs = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.NaN;
  const bMs = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.NaN;
  const aValid = !Number.isNaN(aMs);
  const bValid = !Number.isNaN(bMs);
  if (aValid && bValid && aMs !== bMs) return aMs - bMs;
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (a.updatedAt === b.updatedAt) return a.scheduleId.localeCompare(b.scheduleId);
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

function compareUpdatedDesc(a: ScheduleView, b: ScheduleView): number {
  if (a.updatedAt === b.updatedAt) return a.scheduleId.localeCompare(b.scheduleId);
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/**
 * Splits projections into the Enabled section (ordered by next run, soonest
 * first) and the Disabled section (ordered by recency). Unknown shapes are
 * dropped by normalization before they reach this function.
 */
export function groupSchedules(schedules: readonly ScheduleView[]): GroupedSchedules {
  const enabled = schedules.filter((s) => s.enabled).sort(compareNextRunAsc);
  const disabled = schedules.filter((s) => !s.enabled).sort(compareUpdatedDesc);
  return { enabled, disabled };
}

/**
 * Display-only project filter. Returns the schedules bound to `projectId`;
 * the bound `projectId` on each schedule is preserved untouched, so
 * switching projects never re-scopes a schedule.
 */
export function filterSchedulesByProject(
  schedules: readonly ScheduleView[],
  projectId: string,
): ScheduleView[] {
  return schedules.filter((s) => s.projectId === projectId);
}

/** Counts schedules in the Enabled section (sidebar badge input). */
export function countEnabledSchedules(schedules: readonly ScheduleView[]): number {
  return schedules.filter((s) => s.enabled).length;
}

// ---------------------------------------------------------------------------
// Render hygiene: truncation + secret redaction + formatting
// ---------------------------------------------------------------------------

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function truncateScheduleName(value: string): string {
  return truncateText(value, MAX_SCHEDULE_DISPLAY_NAME);
}

export function truncateSchedulePrompt(value: string): string {
  return truncateText(value, MAX_SCHEDULE_DISPLAY_PROMPT);
}

/**
 * Redacts `key=value`-shaped secret material before render (API keys,
 * tokens, passwords, bearer credentials). Plain prose that merely mentions
 * these words (e.g. "token limit exceeded") passes through untouched —
 * only assignment-shaped fragments are withheld. Mirrors background-tasks.ts.
 */
export function redactSecretAssignments(value: string): string {
  return value
    .replace(/\b[Bb]earer\s+\S+/g, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|oauth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|credential|authorization)\s*[:=]\s*("[^"]*"|'[^']*'|(?!Bearer\b)\S+)/gi,
      "$1: [redacted]",
    );
}

/** Safe timestamp for display; malformed input renders as "—", never throws. */
export function formatScheduleTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * Elapsed wall time between a run's `startedAt` and `finishedAt ?? nowMs`.
 * Returns "—" when the run never started. Pure (clock injectable).
 */
export function formatScheduleRunDuration(run: ScheduleRunView, nowMs?: number): string {
  if (!run.startedAt) return "—";
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return "—";
  const endSource = run.finishedAt ?? undefined;
  const end = endSource ? Date.parse(endSource) : (nowMs ?? Date.now());
  if (Number.isNaN(end) || end < start) return "—";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Countdown to `nextRunAt` relative to `nowMs` (defaults to Date.now()).
 * Future runs render "in 5m 12s" / "in 3h 4m" / "in 2d 3h"; past runs
 * render "overdue by …"; missing/malformed renders "—". Pure.
 */
export function formatNextRunCountdown(nextRunAt: string | undefined, nowMs?: number): string {
  if (!nextRunAt) return "—";
  const target = Date.parse(nextRunAt);
  if (Number.isNaN(target)) return "—";
  const now = nowMs ?? Date.now();
  const diffMs = target - now;
  const absSeconds = Math.floor(Math.abs(diffMs) / 1000);
  const magnitude =
    absSeconds < 60
      ? `${absSeconds}s`
      : absSeconds < 3600
        ? `${Math.floor(absSeconds / 60)}m ${absSeconds % 60}s`
        : absSeconds < 86_400
          ? `${Math.floor(absSeconds / 3600)}h ${Math.floor((absSeconds % 3600) / 60)}m`
          : `${Math.floor(absSeconds / 86_400)}d ${Math.floor((absSeconds % 86_400) / 3600)}h`;
  return diffMs >= 0 ? `in ${magnitude}` : `overdue by ${magnitude}`;
}

/** Human-readable schedule description (used when the bridge omits one). */
export function describeSchedule(view: Pick<ScheduleView, "schedule">): string {
  const config = view.schedule;
  if (config.kind === "interval" && typeof config.intervalMs === "number") {
    const minutes = Math.round(config.intervalMs / 60_000);
    if (minutes < 60) return `Every ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
      return minutes % 60 === 0 ? `Every ${hours}h` : `Every ${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return hours % 24 === 0 ? `Every ${days}d` : `Every ${days}d ${hours % 24}h`;
  }
  if (config.kind === "delay" && typeof config.delayMs === "number") {
    const minutes = Math.round(config.delayMs / 60_000);
    return `After ${minutes}m`;
  }
  if (config.kind === "once" && config.runAt)
    return `Once at ${formatScheduleTimestamp(config.runAt)}`;
  if (config.kind === "weekly" && typeof config.weekday === "number") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const hh = String(config.hour ?? 0).padStart(2, "0");
    const mm = String(config.minute ?? 0).padStart(2, "0");
    return `Weekly ${days[config.weekday] ?? "?"} ${hh}:${mm}`;
  }
  if (config.kind === "daily" && config.dailyTime) return `Daily at ${config.dailyTime}`;
  return config.kind;
}

const TRIGGER_LABELS: Record<ScheduleRunTrigger, string> = {
  scheduled: "Scheduled",
  manual: "Manual",
  recovery: "Recovered",
};

export function scheduleTriggerLabel(trigger: ScheduleRunTrigger): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

const RUN_STATUS_LABELS: Record<ScheduleRunStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function scheduleRunStatusLabel(status: ScheduleRunStatus): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

const RUN_STATUS_BADGE_CLASSES: Record<ScheduleRunStatus, string> = {
  pending: "bg-slate-700 text-slate-200",
  running: "bg-indigo-800 text-indigo-100",
  completed: "bg-emerald-800 text-emerald-100",
  failed: "bg-rose-800 text-rose-100",
  skipped: "bg-slate-700 text-slate-400",
  cancelled: "bg-slate-700 text-slate-400",
};

export function scheduleRunStatusBadgeClass(status: ScheduleRunStatus): string {
  return RUN_STATUS_BADGE_CLASSES[status] ?? "bg-slate-700 text-slate-200";
}

// ---------------------------------------------------------------------------
// Create/edit form validation (client-side; nothing executes until valid)
// ---------------------------------------------------------------------------

export interface ScheduleFormInput {
  readonly name: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly kind: string;
  readonly intervalMs?: number;
  readonly delayMs?: number;
  readonly runAt?: string;
  readonly dailyTime?: string;
  readonly weekday?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly timezone: string;
  readonly overlap: string;
  readonly missedPolicy: string;
  readonly enabled: boolean;
}

export type ScheduleFormErrors = Record<string, string>;

export function isValidTimezone(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the schedule create/edit form. Returns a field→message map;
 * empty means valid. Covers name (1–120), project (1–256), prompt
 * (1–4000), kind + kind-specific config (interval/delay ≥1min; once =
 * parseable ISO timestamp; daily = HH:MM; weekly = weekday+hour+minute),
 * timezone (IANA), and the overlap/missed policies. Callers must not touch
 * the bridge until the map is empty — nothing executes from a partial form.
 */
export function validateScheduleForm(input: ScheduleFormInput): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  const name = input.name.trim();
  if (name.length === 0) errors.name = "Name is required.";
  else if (name.length > MAX_SCHEDULE_DISPLAY_NAME)
    errors.name = `Name must be ≤${MAX_SCHEDULE_DISPLAY_NAME} characters.`;
  const projectId = input.projectId.trim();
  if (projectId.length === 0) errors.projectId = "Project is required.";
  else if (projectId.length > 256) errors.projectId = "Project must be ≤256 characters.";
  const prompt = input.prompt.trim();
  if (prompt.length === 0) errors.prompt = "Prompt is required.";
  else if (prompt.length > MAX_SCHEDULE_DISPLAY_PROMPT)
    errors.prompt = `Prompt must be ≤${MAX_SCHEDULE_DISPLAY_PROMPT} characters.`;
  if (!isScheduleKind(input.kind)) {
    errors.kind = "Schedule kind must be once, delay, interval, daily, or weekly.";
  } else if (input.kind === "interval") {
    if (typeof input.intervalMs !== "number" || !Number.isFinite(input.intervalMs)) {
      errors.intervalMs = "Interval is required.";
    } else if (Math.floor(input.intervalMs) < MIN_SCHEDULE_INTERVAL_MS) {
      errors.intervalMs = "Interval must be at least 1 minute.";
    }
  } else if (input.kind === "delay") {
    if (typeof input.delayMs !== "number" || !Number.isFinite(input.delayMs)) {
      errors.delayMs = "Delay is required.";
    } else if (Math.floor(input.delayMs) < MIN_SCHEDULE_INTERVAL_MS) {
      errors.delayMs = "Delay must be at least 1 minute.";
    }
  } else if (input.kind === "once") {
    const runAt = (input.runAt ?? "").trim();
    if (runAt.length === 0) errors.runAt = "Run time is required for one-shot schedules.";
    else if (Number.isNaN(Date.parse(runAt))) errors.runAt = "Run time must be a valid date/time.";
  } else if (input.kind === "weekly") {
    if (
      typeof input.weekday !== "number" ||
      !Number.isInteger(input.weekday) ||
      input.weekday < 0 ||
      input.weekday > 6
    ) {
      errors.weekday = "Weekday must be 0 (Sun) through 6 (Sat).";
    }
    if (
      typeof input.hour !== "number" ||
      !Number.isInteger(input.hour) ||
      input.hour < 0 ||
      input.hour > 23
    ) {
      errors.hour = "Hour must be 0–23.";
    }
    if (
      typeof input.minute !== "number" ||
      !Number.isInteger(input.minute) ||
      input.minute < 0 ||
      input.minute > 59
    ) {
      errors.minute = "Minute must be 0–59.";
    }
  } else {
    const dailyTime = (input.dailyTime ?? "").trim();
    if (!/^\d{2}:\d{2}$/.test(dailyTime)) {
      errors.dailyTime = "Daily time must be HH:MM (24-hour).";
    } else {
      const [hh, mm] = dailyTime.split(":").map(Number);
      if (hh > 23 || mm > 59) errors.dailyTime = "Daily time must be a valid time.";
    }
  }
  if (!isValidTimezone(input.timezone.trim()))
    errors.timezone = "Timezone must be a valid IANA name.";
  if (!isOverlapPolicy(input.overlap)) errors.overlap = "Overlap policy must be skip or queue.";
  if (!isMissedPolicy(input.missedPolicy))
    errors.missedPolicy = "Missed-run policy must be skip or run_once.";
  return errors;
}

export function isScheduleFormValid(input: ScheduleFormInput): boolean {
  return Object.keys(validateScheduleForm(input)).length === 0;
}

// ---------------------------------------------------------------------------
// Narrow bridge client (`window.api.schedules.*`, optional)
// ---------------------------------------------------------------------------

/**
 * Expected narrow client interface for the schedule IPC
 * (`window.api.schedules.*`, canonical `schedules:*` channels: nested
 * `schedule:{kind,…}` spec, `overlapPolicy`, projectId on every call).
 */
export interface ScheduleSpecArgs {
  readonly kind: string;
  readonly intervalMs?: number;
  readonly delayMs?: number;
  readonly runAt?: string;
  readonly dailyTime?: string;
  readonly weekday?: number;
  readonly hour?: number;
  readonly minute?: number;
}

export interface ScheduleCommands {
  list(args: { projectId: string }): Promise<unknown>;
  get(args: { scheduleId: string; projectId: string }): Promise<unknown>;
  create(args: {
    projectId: string;
    name: string;
    prompt: string;
    schedule: ScheduleSpecArgs;
    timezone?: string;
    description?: string;
    missedPolicy?: string;
    overlapPolicy?: string;
    enabled?: boolean;
  }): Promise<unknown>;
  update(args: {
    scheduleId: string;
    projectId: string;
    name?: string;
    description?: string | null;
    prompt?: string;
    schedule?: ScheduleSpecArgs;
    timezone?: string;
    missedPolicy?: string;
    overlapPolicy?: string;
  }): Promise<unknown>;
  enable(args: { scheduleId: string; projectId: string }): Promise<unknown>;
  disable(args: { scheduleId: string; projectId: string }): Promise<unknown>;
  delete(args: { scheduleId: string; projectId: string }): Promise<unknown>;
  runNow(args: { scheduleId: string; projectId: string }): Promise<unknown>;
  runs(args: { scheduleId: string; projectId: string; limit?: number }): Promise<unknown>;
}

const SCHEDULE_COMMAND_NAMES = [
  "list",
  "get",
  "create",
  "update",
  "enable",
  "disable",
  "delete",
  "runNow",
  "runs",
] as const;

/**
 * Returns the sibling-owned schedule bridge when every expected method is
 * present, otherwise null. Never throws: a missing bridge is an expected
 * pre-landing state, not an error.
 */
export function getScheduleCommands(): ScheduleCommands | null {
  try {
    if (typeof window === "undefined") return null;
    const api = window as unknown as {
      api?: { schedules?: Record<string, unknown> };
    };
    const bridge = api.api?.schedules;
    if (!bridge) return null;
    for (const name of SCHEDULE_COMMAND_NAMES) {
      if (typeof bridge[name] !== "function") return null;
    }
    return bridge as unknown as ScheduleCommands;
  } catch {
    return null;
  }
}

/** Lists projections through the bridge (project-scoped). Absent bridge → []. */
export async function fetchScheduleList(
  commands: ScheduleCommands | null,
  projectId: string,
): Promise<ScheduleView[]> {
  if (!commands) return [];
  const raw = await commands.list({ projectId });
  return normalizeScheduleViews(unwrapScheduleList(raw));
}

/** Fetches one projection. Absent bridge or unknown id → null. */
export async function fetchSchedule(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
): Promise<ScheduleView | null> {
  if (!commands) return null;
  const raw = await commands.get({ scheduleId, projectId });
  return normalizeScheduleView(unwrapSchedule(raw));
}

/** Fetches run history for one schedule. Absent bridge → []. */
export async function fetchScheduleRuns(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
  limit?: number,
): Promise<ScheduleRunView[]> {
  if (!commands) return [];
  const raw = await commands.runs(
    limit ? { scheduleId, projectId, limit } : { scheduleId, projectId },
  );
  return normalizeScheduleRunViews(unwrapScheduleRuns(raw));
}

export interface ScheduleCommandResult {
  readonly ok: boolean;
  readonly error: string | null;
}

function toCommandResult(raw: unknown, action: string): ScheduleCommandResult {
  if (isRecord(raw) && raw.ok === false) {
    const error = isRecord(raw.error)
      ? asOptionalString(raw.error.message)
      : asOptionalString(raw.error);
    return { ok: false, error: error ?? `${action} failed` };
  }
  return { ok: true, error: null };
}

async function runBridgeCommand(
  commands: ScheduleCommands | null,
  action: string,
  invoke: (bridge: ScheduleCommands) => Promise<unknown>,
): Promise<ScheduleCommandResult> {
  if (!commands) return { ok: false, error: "Schedules IPC is not available yet." };
  try {
    return toCommandResult(await invoke(commands), action);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `${action} failed` };
  }
}

/**
 * Builds the canonical nested `schedule:{kind,…}` spec from flat form
 * input. Returns null when the kind-specific config is absent (callers
 * validate first, so this is a defensive backstop).
 */
export function toScheduleSpecArgs(input: ScheduleFormInput): ScheduleSpecArgs | null {
  if (input.kind === "interval" && typeof input.intervalMs === "number") {
    return { kind: "interval", intervalMs: Math.floor(input.intervalMs) };
  }
  if (input.kind === "delay" && typeof input.delayMs === "number") {
    return { kind: "delay", delayMs: Math.floor(input.delayMs) };
  }
  if (input.kind === "once" && input.runAt) {
    return { kind: "once", runAt: input.runAt };
  }
  if (input.kind === "daily" && input.dailyTime) {
    return { kind: "daily", dailyTime: input.dailyTime };
  }
  if (
    input.kind === "weekly" &&
    typeof input.weekday === "number" &&
    typeof input.hour === "number" &&
    typeof input.minute === "number"
  ) {
    return { kind: "weekly", weekday: input.weekday, hour: input.hour, minute: input.minute };
  }
  return null;
}

export function createSchedule(
  commands: ScheduleCommands | null,
  input: ScheduleFormInput,
): Promise<ScheduleCommandResult> {
  return runBridgeCommand(commands, "create", (bridge) => {
    const schedule = toScheduleSpecArgs(input);
    if (!schedule) throw new Error("Schedule configuration is incomplete.");
    return bridge.create({
      projectId: input.projectId.trim(),
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      schedule,
      timezone: input.timezone.trim(),
      missedPolicy: input.missedPolicy,
      overlapPolicy: toCanonicalOverlapPolicy(input.overlap),
      enabled: input.enabled,
    });
  });
}

export function updateSchedule(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
  patch: Partial<Omit<ScheduleFormInput, "projectId">>,
): Promise<ScheduleCommandResult> {
  return runBridgeCommand(commands, "update", (bridge) => {
    const schedule =
      patch.kind !== undefined
        ? toScheduleSpecArgs({ ...patch, projectId: "", name: "", prompt: "" } as ScheduleFormInput)
        : undefined;
    return bridge.update({
      scheduleId,
      projectId,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
      ...(schedule ? { schedule } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone.trim() } : {}),
      ...(patch.missedPolicy !== undefined ? { missedPolicy: patch.missedPolicy } : {}),
      ...(patch.overlap !== undefined
        ? { overlapPolicy: toCanonicalOverlapPolicy(patch.overlap) }
        : {}),
    });
  });
}

export function enableSchedule(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
): Promise<ScheduleCommandResult> {
  return runBridgeCommand(commands, "enable", (bridge) => bridge.enable({ scheduleId, projectId }));
}

export function disableSchedule(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
): Promise<ScheduleCommandResult> {
  return runBridgeCommand(commands, "disable", (bridge) =>
    bridge.disable({ scheduleId, projectId }),
  );
}

/**
 * Deletes a schedule definition. Deleting never cancels an already-running
 * task: runs launched earlier keep their own lifecycle behind the
 * background-task bridge. The UI states this explicitly.
 */
export function deleteSchedule(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
): Promise<ScheduleCommandResult> {
  return runBridgeCommand(commands, "delete", (bridge) => bridge.delete({ scheduleId, projectId }));
}

/** Launches one manual run for a schedule (labeled Manual, never auto-approved). */
export function runScheduleNow(
  commands: ScheduleCommands | null,
  scheduleId: string,
  projectId: string,
): Promise<ScheduleCommandResult> {
  return runBridgeCommand(commands, "run now", (bridge) =>
    bridge.runNow({ scheduleId, projectId }),
  );
}

// ---------------------------------------------------------------------------
// Local stub (pre-IPC stand-in; renderer-local only, never a source of truth)
// ---------------------------------------------------------------------------

export interface LocalScheduleSeed {
  readonly scheduleId: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly enabled?: boolean;
  readonly timezone?: string;
  readonly kind?: ScheduleKind;
  readonly intervalMs?: number;
  readonly delayMs?: number;
  readonly runAt?: string;
  readonly dailyTime?: string;
  readonly weekday?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly overlap?: OverlapPolicy;
  readonly missedPolicy?: MissedPolicy;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
}

/**
 * In-memory stand-in implementing `ScheduleCommands` with IPC-shaped
 * envelopes. Used when the sibling bridge is absent so the Schedule Center
 * renders an honest empty/disabled state and tests exercise the full
 * normalize → group → display pipeline. Production state always re-queries
 * the real bridge on mount, so stub contents never leak across a real
 * landing.
 */
export function createLocalScheduleStub(
  initial: readonly LocalScheduleSeed[] = [],
): ScheduleCommands & {
  seed(view: LocalScheduleSeed): void;
  seedRun(run: {
    runId: string;
    scheduleId: string;
    projectId: string;
    status: ScheduleRunStatus;
    trigger?: ScheduleRunTrigger;
    startedAt?: string;
    finishedAt?: string;
  }): void;
} {
  const schedules = new Map<string, ScheduleView>();
  const runs = new Map<string, ScheduleRunView[]>();
  const envelope = (value: unknown): unknown => ({ ok: true, value });
  const failure = (message: string): unknown => ({ ok: false, error: { message } });
  const nowIso = (): string => new Date().toISOString();

  const toView = (seed: LocalScheduleSeed): ScheduleView | null => {
    const kind: ScheduleKind =
      seed.kind ??
      (seed.runAt ? "once" : seed.dailyTime ? "daily" : seed.delayMs ? "delay" : "interval");
    const candidate: Record<string, unknown> = {
      scheduleId: seed.scheduleId,
      projectId: seed.projectId ?? "proj-A",
      name: seed.name ?? "Untitled schedule",
      prompt: seed.prompt ?? "Do the scheduled work and report what changed.",
      enabled: seed.enabled ?? true,
      timezone: seed.timezone ?? "UTC",
      schedule: {
        kind,
        ...(kind === "interval" ? { intervalMs: seed.intervalMs ?? 3_600_000 } : {}),
        ...(kind === "delay" ? { delayMs: seed.delayMs ?? 3_600_000 } : {}),
        ...(kind === "once" ? { runAt: seed.runAt ?? nowIso() } : {}),
        ...(kind === "daily" ? { dailyTime: seed.dailyTime ?? "09:00" } : {}),
        ...(kind === "weekly"
          ? {
              weekday: seed.weekday ?? 1,
              hour: seed.hour ?? 9,
              minute: seed.minute ?? 0,
            }
          : {}),
      },
      overlap: seed.overlap ?? "skip",
      missedPolicy: seed.missedPolicy ?? "skip",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...(seed.nextRunAt ? { nextRunAt: seed.nextRunAt } : {}),
      ...(seed.lastRunAt ? { lastRunAt: seed.lastRunAt } : {}),
    };
    return normalizeScheduleView(candidate);
  };

  for (const seed of initial) {
    const view = toView(seed);
    if (view) schedules.set(view.scheduleId, view);
  }

  const computeNextRun = (view: ScheduleView): string => {
    const now = Date.now();
    if (view.schedule.kind === "interval" && typeof view.schedule.intervalMs === "number") {
      return new Date(now + view.schedule.intervalMs).toISOString();
    }
    if (view.schedule.kind === "delay" && typeof view.schedule.delayMs === "number") {
      return new Date(now + view.schedule.delayMs).toISOString();
    }
    if (view.schedule.kind === "once" && view.schedule.runAt) return view.schedule.runAt;
    return new Date(now + 3_600_000).toISOString();
  };

  const requireOwned = (
    scheduleId: string,
    projectId: string,
  ): ScheduleView | { failure: string } => {
    const current = schedules.get(scheduleId);
    if (!current) return { failure: `not-found: ${scheduleId}` };
    if (current.projectId !== projectId) return { failure: "project-mismatch: wrong project" };
    return current;
  };

  return {
    seed(seed: LocalScheduleSeed): void {
      const view = toView(seed);
      if (view) schedules.set(view.scheduleId, view);
    },
    seedRun(run: {
      runId: string;
      scheduleId: string;
      projectId: string;
      status: ScheduleRunStatus;
      trigger?: ScheduleRunTrigger;
      startedAt?: string;
      finishedAt?: string;
    }): void {
      const view = normalizeScheduleRunView({
        ...run,
        trigger: run.trigger ?? "scheduled",
        createdAt: run.startedAt ?? nowIso(),
      });
      if (!view) return;
      const list = runs.get(view.scheduleId) ?? [];
      list.push(view);
      runs.set(view.scheduleId, list);
    },
    async list(args: { projectId: string }): Promise<unknown> {
      if (schedules.size > MAX_SCHEDULES_TOTAL) {
        return failure(`limit-reached: at most ${MAX_SCHEDULES_TOTAL} schedules`);
      }
      const all = [...schedules.values()];
      return envelope({ schedules: all.filter((s) => s.projectId === args.projectId) });
    },
    async get(args: { scheduleId: string; projectId: string }): Promise<unknown> {
      const owned = requireOwned(args.scheduleId, args.projectId);
      if ("failure" in owned) return failure(owned.failure);
      return envelope({ schedule: owned });
    },
    async create(args: {
      projectId: string;
      name: string;
      prompt: string;
      schedule: ScheduleSpecArgs;
      timezone?: string;
      description?: string;
      missedPolicy?: string;
      overlapPolicy?: string;
      enabled?: boolean;
    }): Promise<unknown> {
      const spec = args.schedule;
      const errors = validateScheduleForm({
        name: args.name,
        projectId: args.projectId,
        prompt: args.prompt,
        kind: spec.kind,
        intervalMs: spec.intervalMs,
        delayMs: spec.delayMs,
        runAt: spec.runAt,
        dailyTime: spec.dailyTime,
        weekday: spec.weekday,
        hour: spec.hour,
        minute: spec.minute,
        timezone: args.timezone ?? "UTC",
        overlap: toDisplayOverlapPolicy(args.overlapPolicy ?? "skip"),
        missedPolicy: args.missedPolicy ?? "skip",
        enabled: args.enabled ?? true,
      });
      const first = Object.values(errors)[0];
      if (first) return failure(`validation-error: ${first}`);
      if (schedules.size >= MAX_SCHEDULES_TOTAL) {
        return failure(`limit-reached: at most ${MAX_SCHEDULES_TOTAL} schedules`);
      }
      const now = nowIso();
      const scheduleId = `01SCHED${String(schedules.size).padStart(4, "0")}00000000`;
      const candidate = normalizeScheduleView({
        scheduleId,
        projectId: args.projectId.trim(),
        name: args.name.trim().slice(0, MAX_SCHEDULE_DISPLAY_NAME),
        prompt: args.prompt.trim().slice(0, MAX_SCHEDULE_DISPLAY_PROMPT),
        enabled: args.enabled ?? true,
        timezone: (args.timezone ?? "UTC").trim(),
        schedule: {
          kind: spec.kind,
          ...(spec.kind === "interval" ? { intervalMs: Math.floor(spec.intervalMs ?? 0) } : {}),
          ...(spec.kind === "delay" ? { delayMs: Math.floor(spec.delayMs ?? 0) } : {}),
          ...(spec.kind === "once" ? { runAt: spec.runAt } : {}),
          ...(spec.kind === "daily" ? { dailyTime: spec.dailyTime } : {}),
          ...(spec.kind === "weekly"
            ? { weekday: spec.weekday, hour: spec.hour, minute: spec.minute }
            : {}),
        },
        overlap: args.overlapPolicy ?? "skip",
        missedPolicy: args.missedPolicy ?? "skip",
        createdAt: now,
        updatedAt: now,
      });
      if (!candidate) return failure("validation-error: schedule config is invalid");
      const withNext: ScheduleView = {
        ...candidate,
        nextRunAt: candidate.enabled ? computeNextRun(candidate) : undefined,
      };
      schedules.set(scheduleId, withNext);
      return envelope({ schedule: withNext });
    },
    async update(args: {
      scheduleId: string;
      projectId: string;
      name?: string;
      description?: string | null;
      prompt?: string;
      schedule?: ScheduleSpecArgs;
      timezone?: string;
      missedPolicy?: string;
      overlapPolicy?: string;
    }): Promise<unknown> {
      const owned = requireOwned(args.scheduleId, args.projectId);
      if ("failure" in owned) return failure(owned.failure);
      const current = owned;
      // Project is locked per schedule: the bound projectId is never changed.
      const nextKind = (args.schedule?.kind ?? current.schedule.kind) as ScheduleKind;
      if (args.schedule?.kind !== undefined && !isScheduleKind(args.schedule.kind)) {
        return failure(
          "validation-error: Schedule kind must be once, delay, interval, daily, or weekly.",
        );
      }
      if (args.name !== undefined) {
        const name = args.name.trim();
        if (name.length === 0) return failure("validation-error: Name is required.");
        if (name.length > MAX_SCHEDULE_DISPLAY_NAME)
          return failure(
            `validation-error: Name must be ≤${MAX_SCHEDULE_DISPLAY_NAME} characters.`,
          );
      }
      if (args.prompt !== undefined) {
        const prompt = args.prompt.trim();
        if (prompt.length === 0) return failure("validation-error: Prompt is required.");
        if (prompt.length > MAX_SCHEDULE_DISPLAY_PROMPT)
          return failure(
            `validation-error: Prompt must be ≤${MAX_SCHEDULE_DISPLAY_PROMPT} characters.`,
          );
      }
      if (nextKind === "interval") {
        const intervalMs =
          args.schedule?.kind === "interval" && typeof args.schedule.intervalMs === "number"
            ? Math.floor(args.schedule.intervalMs)
            : current.schedule.kind === "interval"
              ? (current.schedule.intervalMs ?? MIN_SCHEDULE_INTERVAL_MS)
              : MIN_SCHEDULE_INTERVAL_MS;
        if (intervalMs < MIN_SCHEDULE_INTERVAL_MS)
          return failure("validation-error: Interval must be at least 1 minute.");
      }
      if (args.timezone !== undefined && !isValidTimezone(args.timezone.trim())) {
        return failure("validation-error: Timezone must be a valid IANA name.");
      }
      if (args.overlapPolicy !== undefined && !isOverlapPolicy(args.overlapPolicy)) {
        return failure("validation-error: Overlap policy must be skip or queue.");
      }
      if (args.missedPolicy !== undefined && !isMissedPolicy(args.missedPolicy)) {
        return failure("validation-error: Missed-run policy must be skip or run_once.");
      }
      const now = nowIso();
      const specPatch = args.schedule;
      const mergedSchedule: ScheduleConfig =
        nextKind === "interval"
          ? {
              kind: "interval",
              intervalMs:
                specPatch?.kind === "interval" && typeof specPatch.intervalMs === "number"
                  ? Math.floor(specPatch.intervalMs)
                  : current.schedule.kind === "interval"
                    ? (current.schedule.intervalMs ?? MIN_SCHEDULE_INTERVAL_MS)
                    : MIN_SCHEDULE_INTERVAL_MS,
            }
          : nextKind === "delay"
            ? {
                kind: "delay",
                delayMs:
                  specPatch?.kind === "delay" && typeof specPatch.delayMs === "number"
                    ? Math.floor(specPatch.delayMs)
                    : current.schedule.kind === "delay"
                      ? (current.schedule.delayMs ?? MIN_SCHEDULE_INTERVAL_MS)
                      : MIN_SCHEDULE_INTERVAL_MS,
              }
            : nextKind === "once"
              ? {
                  kind: "once",
                  runAt:
                    specPatch?.kind === "once" && specPatch.runAt
                      ? specPatch.runAt
                      : current.schedule.kind === "once"
                        ? current.schedule.runAt
                        : nowIso(),
                }
              : nextKind === "weekly"
                ? {
                    kind: "weekly",
                    weekday:
                      specPatch?.kind === "weekly" && typeof specPatch.weekday === "number"
                        ? specPatch.weekday
                        : current.schedule.kind === "weekly"
                          ? (current.schedule.weekday ?? 1)
                          : 1,
                    hour:
                      specPatch?.kind === "weekly" && typeof specPatch.hour === "number"
                        ? specPatch.hour
                        : current.schedule.kind === "weekly"
                          ? (current.schedule.hour ?? 9)
                          : 9,
                    minute:
                      specPatch?.kind === "weekly" && typeof specPatch.minute === "number"
                        ? specPatch.minute
                        : current.schedule.kind === "weekly"
                          ? (current.schedule.minute ?? 0)
                          : 0,
                  }
                : {
                    kind: "daily",
                    dailyTime:
                      specPatch?.kind === "daily" && specPatch.dailyTime
                        ? specPatch.dailyTime
                        : current.schedule.kind === "daily"
                          ? current.schedule.dailyTime
                          : "09:00",
                  };
      const merged: ScheduleView = {
        ...current,
        name: args.name !== undefined ? args.name.trim() : current.name,
        prompt: args.prompt !== undefined ? args.prompt.trim() : current.prompt,
        timezone: args.timezone !== undefined ? args.timezone.trim() : current.timezone,
        schedule: mergedSchedule,
        overlap: (args.overlapPolicy as OverlapPolicy | undefined) ?? current.overlap,
        missedPolicy: (args.missedPolicy as MissedPolicy | undefined) ?? current.missedPolicy,
        updatedAt: now,
      };
      const validated = normalizeScheduleView(merged);
      if (!validated) return failure("validation-error: schedule config is invalid");
      const withNext: ScheduleView = {
        ...validated,
        nextRunAt: validated.enabled ? computeNextRun(validated) : undefined,
      };
      schedules.set(args.scheduleId, withNext);
      return envelope({ schedule: withNext });
    },
    async enable(args: { scheduleId: string; projectId: string }): Promise<unknown> {
      const owned = requireOwned(args.scheduleId, args.projectId);
      if ("failure" in owned) return failure(owned.failure);
      const current = owned;
      const now = nowIso();
      const next: ScheduleView = {
        ...current,
        enabled: true,
        updatedAt: now,
        nextRunAt: computeNextRun({ ...current, enabled: true }),
      };
      schedules.set(args.scheduleId, next);
      return envelope({ schedule: next });
    },
    async disable(args: { scheduleId: string; projectId: string }): Promise<unknown> {
      const owned = requireOwned(args.scheduleId, args.projectId);
      if ("failure" in owned) return failure(owned.failure);
      const current = owned;
      const next: ScheduleView = {
        ...current,
        enabled: false,
        updatedAt: nowIso(),
        nextRunAt: undefined,
      };
      schedules.set(args.scheduleId, next);
      return envelope({ schedule: next });
    },
    async delete(args: { scheduleId: string; projectId: string }): Promise<unknown> {
      const owned = requireOwned(args.scheduleId, args.projectId);
      if ("failure" in owned) return failure(owned.failure);
      // Deleting removes the definition only: run history stays queryable
      // and already-running tasks keep their own lifecycle (delete≠cancel).
      schedules.delete(args.scheduleId);
      return envelope({ deleted: true, scheduleId: args.scheduleId });
    },
    async runNow(args: { scheduleId: string; projectId: string }): Promise<unknown> {
      const owned = requireOwned(args.scheduleId, args.projectId);
      if ("failure" in owned) return failure(owned.failure);
      const current = owned;
      const now = nowIso();
      const run: ScheduleRunView = {
        runId: `01RUN${String((runs.get(args.scheduleId) ?? []).length).padStart(4, "0")}00000000`,
        scheduleId: args.scheduleId,
        projectId: current.projectId,
        status: "pending",
        trigger: "manual",
        createdAt: now,
        startedAt: now,
      };
      const list = runs.get(args.scheduleId) ?? [];
      list.push(run);
      runs.set(args.scheduleId, list);
      const next: ScheduleView = {
        ...current,
        lastRunAt: now,
        lastRunStatus: "pending",
        updatedAt: now,
      };
      schedules.set(args.scheduleId, next);
      return envelope({ run, schedule: next });
    },
    async runs(args: { scheduleId: string; projectId: string; limit?: number }): Promise<unknown> {
      const stored = runs.get(args.scheduleId) ?? [];
      const owned = schedules.get(args.scheduleId);
      if (owned) {
        if (owned.projectId !== args.projectId) {
          return failure("project-mismatch: wrong project");
        }
      } else if (stored.length > 0) {
        // History survives the definition delete: scope against the runs'
        // own bound projectId instead of the removed definition.
        if (stored[0]?.projectId !== args.projectId) {
          return failure("project-mismatch: wrong project");
        }
      } else {
        return failure(`not-found: ${args.scheduleId}`);
      }
      const list = [...stored].sort((a, b) =>
        (b.startedAt ?? b.createdAt ?? "").localeCompare(a.startedAt ?? a.createdAt ?? ""),
      );
      const limit =
        typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0
          ? Math.min(args.limit, MAX_SCHEDULE_RUNS_SHOWN)
          : MAX_SCHEDULE_RUNS_SHOWN;
      return envelope({ runs: list.slice(0, limit) });
    },
  };
}
