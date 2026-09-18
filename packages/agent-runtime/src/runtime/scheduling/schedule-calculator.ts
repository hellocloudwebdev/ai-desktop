// PR44: packages/agent-runtime — Schedule Calculator (CORE pure computation)
//
// Pure next-run / due-occurrence computation for schedules. Zero timers, zero
// I/O, zero tool/shell/fs/network use: every function is a deterministic
// mapping of (kind, config, timezone, anchor timestamps) -> UTC milliseconds.
//
// Timezone math uses built-in Intl only (no date library exists in the repo):
//   - Wall-clock parts are read via a cached Intl.DateTimeFormat with the
//     persisted schedule `timeZone`.
//   - Wall-clock -> UTC resolves the tz offset iteratively, then verifies by
//     formatting back. DST gaps (spring-forward, e.g. 02:30 on 2026-03-08 in
//     America/New_York) fail verification and fall back to a forward scan for
//     the next valid wall-clock minute on the same wall day (03:00). DST
//     overlaps (fall-back) converge on the FIRST occurrence. Asia/Kolkata has
//     no DST but the code never assumes that; every day is resolved the same
//     way.
//   - The persisted `timezone` string is authoritative, so host system-tz
//     changes cannot shift firing times.
//
// Min-interval enforcement (ai-core MIN_INTERVAL_MS, default 60_000) applies
// to delayMs/everyMs here and in validateScheduleInput; tests may override it
// via the options param only, never via persisted data.

import {
  isValidTimezone,
  MIN_INTERVAL_MS,
  type ScheduleConfig,
  type ScheduleKind,
} from "@ai-desktop/ai-core";

// ---------------------------------------------------------------------------
// Options / Query Shapes
// ---------------------------------------------------------------------------

export interface CalculatorOptions {
  /**
   * Test-only override for the MIN_INTERVAL_MS floor on delayMs/everyMs.
   * Never sourced from persisted data.
   */
  readonly minIntervalMs?: number;
}

export interface OccurrenceQuery {
  readonly kind: ScheduleKind;
  readonly config: ScheduleConfig;
  readonly timezone: string;
  /**
   * Creation timestamp (ms). Required for `delay` (fire time is
   * createdAt + delayMs) and used as the interval anchor when no run has
   * fired yet. Ignored by once/daily/weekly.
   */
  readonly createdAtMs?: number;
}

export interface DueWindow extends OccurrenceQuery {
  /** Exclusive lower bound: lastRunAt ?? createdAt (ms). */
  readonly anchorMs: number;
  /** Inclusive upper bound: now (ms). */
  readonly nowMs: number;
  /** True once a one-shot (once/delay) schedule has fired. */
  readonly consumed: boolean;
}

export interface DueResult {
  readonly count: number;
  readonly earliestMs: number | undefined;
  readonly latestMs: number | undefined;
}

// ---------------------------------------------------------------------------
// Guards (all violations throw validation-error prefixed Errors)
// ---------------------------------------------------------------------------

export function requireValidTimezone(timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new Error(`validation-error: invalid timezone "${String(timezone)}"`);
  }
}

function requireKindConfigMatch(kind: ScheduleKind, config: ScheduleConfig): void {
  const c = config as Record<string, unknown>;
  const ok =
    (kind === "once" && typeof c.runAt === "string") ||
    (kind === "delay" && typeof c.delayMs === "number") ||
    (kind === "interval" && typeof c.everyMs === "number") ||
    (kind === "daily" &&
      typeof c.hour === "number" &&
      typeof c.minute === "number" &&
      !("weekday" in c)) ||
    (kind === "weekly" &&
      typeof c.weekday === "number" &&
      typeof c.hour === "number" &&
      typeof c.minute === "number");
  if (!ok) {
    throw new Error(`validation-error: schedule config does not match kind "${kind}"`);
  }
}

function requireMinInterval(
  kind: ScheduleKind,
  config: ScheduleConfig,
  options?: CalculatorOptions,
): void {
  const floor = options?.minIntervalMs ?? MIN_INTERVAL_MS;
  const c = config as { delayMs?: unknown; everyMs?: unknown };
  const ms = kind === "delay" ? c.delayMs : kind === "interval" ? c.everyMs : undefined;
  if (typeof ms === "number" && ms < floor) {
    throw new Error(
      `validation-error: schedule interval must be at least ${floor}ms (got ${ms}ms)`,
    );
  }
}

function checkedQuery(query: OccurrenceQuery, options?: CalculatorOptions): void {
  requireValidTimezone(query.timezone);
  requireKindConfigMatch(query.kind, query.config);
  requireMinInterval(query.kind, query.config, options);
}

function parseRunAtMs(runAt: string): number {
  const ms = Date.parse(runAt);
  if (!Number.isFinite(ms)) {
    throw new Error(`validation-error: invalid runAt timestamp "${runAt}"`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Intl Wall-Clock Helpers
// ---------------------------------------------------------------------------

interface TzWallParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly second: number; // 0-59
  readonly weekdaySun0: number; // 0 (Sun) - 6 (Sat)
}

const WEEKDAY_SUN0: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function wallParts(timezone: string, ms: number): TzWallParts {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // Some ICU builds render midnight as "24" with hour12:false; normalize.
  const hour = Number(get("hour")) % 24;
  const weekday = WEEKDAY_SUN0[get("weekday")] ?? 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekdaySun0: weekday,
  };
}

/**
 * Resolves a wall-clock time in `timezone` to UTC milliseconds. Verifies by
 * formatting back; on a DST gap (nonexistent wall time) scans forward from
 * well before the target for the next valid wall-clock minute on the same
 * wall day. On a DST overlap the iteration converges on the first occurrence.
 */
export function zonedTimeToUtc(
  timezone: string,
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
): number {
  requireValidTimezone(timezone);
  const wallAsUtc = Date.UTC(year, month1 - 1, day, hour, minute, 0);
  let guess = wallAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const p = wallParts(timezone, guess);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = wallAsUtc - (asUtc - guess);
  }
  const check = wallParts(timezone, guess);
  if (
    check.year === year &&
    check.month === month1 &&
    check.day === day &&
    check.hour === hour &&
    check.minute === minute
  ) {
    return guess;
  }
  // DST gap: the wall time never occurs. Scan forward minute-by-minute from
  // safely before the target for the first instant whose wall time is on the
  // same wall day at or past the target (the next valid wall-clock minute).
  const targetMinutes = hour * 60 + minute;
  const start = wallAsUtc - 18 * 3_600_000;
  const end = wallAsUtc + 18 * 3_600_000;
  for (let candidate = start; candidate <= end; candidate += 60_000) {
    const p = wallParts(timezone, candidate);
    if (
      p.year === year &&
      p.month === month1 &&
      p.day === day &&
      p.hour * 60 + p.minute >= targetMinutes
    ) {
      return candidate - p.second * 1000;
    }
  }
  throw new Error(
    `validation-error: cannot resolve wall time ${year}-${month1}-${day} ${hour}:${minute} in timezone "${timezone}"`,
  );
}

function addWallDays(
  year: number,
  month1: number,
  day: number,
  deltaDays: number,
): {
  year: number;
  month1: number;
  day: number;
} {
  const dt = new Date(Date.UTC(year, month1 - 1, day) + deltaDays * 86_400_000);
  return {
    year: dt.getUTCFullYear(),
    month1: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

/** First daily occurrence strictly after `afterMs`. */
function firstDailyAfter(timezone: string, hour: number, minute: number, afterMs: number): number {
  const start = wallParts(timezone, afterMs);
  for (let d = 0; d <= 370; d += 1) {
    const ymd = addWallDays(start.year, start.month, start.day, d);
    const utc = zonedTimeToUtc(timezone, ymd.year, ymd.month1, ymd.day, hour, minute);
    if (utc > afterMs) return utc;
  }
  throw new Error("validation-error: no daily occurrence found within 370 days");
}

/** First weekly occurrence strictly after `afterMs`. */
function firstWeeklyAfter(
  timezone: string,
  weekday: number,
  hour: number,
  minute: number,
  afterMs: number,
): number {
  const start = wallParts(timezone, afterMs);
  for (let d = 0; d <= 7; d += 1) {
    const ymd = addWallDays(start.year, start.month, start.day, d);
    const ymdWeekday = new Date(Date.UTC(ymd.year, ymd.month1 - 1, ymd.day)).getUTCDay();
    if (ymdWeekday !== weekday) continue;
    const utc = zonedTimeToUtc(timezone, ymd.year, ymd.month1, ymd.day, hour, minute);
    if (utc > afterMs) return utc;
  }
  throw new Error("validation-error: no weekly occurrence found within 8 days");
}

function firstWallAfter(timezone: string, config: ScheduleConfig, afterMs: number): number {
  const c = config as { hour?: number; minute?: number; weekday?: number };
  if (typeof c.weekday === "number") {
    return firstWeeklyAfter(timezone, c.weekday, c.hour ?? 0, c.minute ?? 0, afterMs);
  }
  return firstDailyAfter(timezone, c.hour ?? 0, c.minute ?? 0, afterMs);
}

// ---------------------------------------------------------------------------
// Public Pure API
// ---------------------------------------------------------------------------

function delayFireMs(query: OccurrenceQuery): number {
  if (query.createdAtMs === undefined || !Number.isFinite(query.createdAtMs)) {
    throw new Error("validation-error: delay schedules require createdAtMs");
  }
  return query.createdAtMs + (query.config as { delayMs: number }).delayMs;
}

/**
 * The initial fire time for a schedule created at `createdAtMs`.
 * `delay` is converted to runAt at creation (createdAt + delayMs).
 */
export function initialOccurrenceMs(query: OccurrenceQuery, options?: CalculatorOptions): number {
  checkedQuery(query, options);
  switch (query.kind) {
    case "once":
      return parseRunAtMs((query.config as { runAt: string }).runAt);
    case "delay":
      return delayFireMs(query);
    case "interval":
      if (query.createdAtMs === undefined || !Number.isFinite(query.createdAtMs)) {
        throw new Error("validation-error: interval schedules require createdAtMs");
      }
      return query.createdAtMs + (query.config as { everyMs: number }).everyMs;
    case "daily":
    case "weekly": {
      if (query.createdAtMs === undefined || !Number.isFinite(query.createdAtMs)) {
        throw new Error(`validation-error: ${query.kind} schedules require createdAtMs`);
      }
      return firstWallAfter(query.timezone, query.config, query.createdAtMs);
    }
  }
}

/**
 * The occurrence strictly after an already-handled occurrence time, or null
 * when the schedule is one-shot (once/delay) and therefore consumed.
 */
export function nextAfterHandledMs(
  query: OccurrenceQuery,
  handledMs: number,
  options?: CalculatorOptions,
): number | null {
  checkedQuery(query, options);
  switch (query.kind) {
    case "once":
    case "delay":
      return null;
    case "interval":
      return handledMs + (query.config as { everyMs: number }).everyMs;
    case "daily":
    case "weekly":
      return firstWallAfter(query.timezone, query.config, handledMs);
  }
}

/**
 * The next occurrence strictly after `nowMs` given the current anchor
 * (lastRunAt ?? createdAt), or null when a one-shot schedule is consumed or
 * its single fire time has passed. Used to re-point nextRunAt.
 */
export function nextPointerAfterNow(
  query: OccurrenceQuery & { anchorMs: number; consumed: boolean },
  nowMs: number,
  options?: CalculatorOptions,
): number | null {
  checkedQuery(query, options);
  switch (query.kind) {
    case "once": {
      if (query.consumed) return null;
      const t = parseRunAtMs((query.config as { runAt: string }).runAt);
      return t > nowMs ? t : null;
    }
    case "delay": {
      if (query.consumed) return null;
      const f = delayFireMs(query);
      return f > nowMs ? f : null;
    }
    case "interval": {
      const everyMs = (query.config as { everyMs: number }).everyMs;
      if (nowMs < query.anchorMs) return query.anchorMs + everyMs;
      const steps = Math.floor((nowMs - query.anchorMs) / everyMs) + 1;
      return query.anchorMs + steps * everyMs;
    }
    case "daily":
    case "weekly":
      return firstWallAfter(query.timezone, query.config, nowMs);
  }
}

/**
 * Counts occurrences in the half-open window (anchorMs, nowMs]: every firing
 * time the scheduler has not yet handled. Returns the count plus the
 * earliest/latest due times (undefined when count is 0). Daily/weekly
 * enumeration is bounded (4000 occurrences, ~10 years of daily); beyond that
 * the caller has a clock/configuration problem and gets an error, never a hang.
 */
export function countDueOccurrences(window: DueWindow, options?: CalculatorOptions): DueResult {
  checkedQuery(window, options);
  const empty: DueResult = { count: 0, earliestMs: undefined, latestMs: undefined };
  if (window.nowMs <= window.anchorMs) return empty;
  switch (window.kind) {
    case "once": {
      if (window.consumed) return empty;
      const t = parseRunAtMs((window.config as { runAt: string }).runAt);
      if (t > window.anchorMs && t <= window.nowMs) {
        return { count: 1, earliestMs: t, latestMs: t };
      }
      return empty;
    }
    case "delay": {
      if (window.consumed) return empty;
      const f = delayFireMs(window);
      if (f > window.anchorMs && f <= window.nowMs) {
        return { count: 1, earliestMs: f, latestMs: f };
      }
      return empty;
    }
    case "interval": {
      const everyMs = (window.config as { everyMs: number }).everyMs;
      const count = Math.floor((window.nowMs - window.anchorMs) / everyMs);
      if (count < 1) return empty;
      return {
        count,
        earliestMs: window.anchorMs + everyMs,
        latestMs: window.anchorMs + count * everyMs,
      };
    }
    case "daily":
    case "weekly": {
      let count = 0;
      let earliest: number | undefined;
      let latest: number | undefined;
      let cursor: number | null = firstWallAfter(window.timezone, window.config, window.anchorMs);
      let guard = 0;
      while (cursor !== null && cursor <= window.nowMs) {
        count += 1;
        if (earliest === undefined) earliest = cursor;
        latest = cursor;
        guard += 1;
        if (guard > 4000) {
          throw new Error(
            "validation-error: occurrence enumeration exceeded 4000 (check anchor/now)",
          );
        }
        cursor = firstWallAfter(window.timezone, window.config, cursor);
      }
      return { count, earliestMs: earliest, latestMs: latest };
    }
  }
}
