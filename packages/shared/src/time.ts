// PR3: packages/shared — Time Primitives
//
// Establishes a uniform ISO-8601 UTC timestamp representation across all packages
// and events so that packages do not independently invent timestamp conventions.
//
// Format: Canonical ISO-8601 UTC string (e.g. "2026-09-06T12:34:56.789Z").

import type { Brand } from "./ids.js";
import { ValidationError } from "./errors.js";

export type Timestamp = Brand<string, "Timestamp">;

const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * Creates a branded ISO-8601 UTC Timestamp string from an optional Date, epoch ms, or ISO string.
 * Defaults to current time (Date.now()).
 */
export function createTimestamp(source: Date | number | string = Date.now()): Timestamp {
  let date: Date;
  if (source instanceof Date) {
    date = source;
  } else if (typeof source === "number") {
    date = new Date(source);
  } else if (typeof source === "string") {
    date = new Date(source);
  } else {
    throw new ValidationError(`Invalid timestamp source: ${String(source)}`);
  }

  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`Invalid timestamp value could not be parsed: ${String(source)}`);
  }

  return date.toISOString() as Timestamp;
}

/**
 * Convenience helper that returns the current time as a branded Timestamp.
 */
export function now(): Timestamp {
  return new Date().toISOString() as Timestamp;
}

/**
 * Validates whether a given value is a valid ISO-8601 UTC Timestamp.
 */
export function isTimestamp(value: unknown): value is Timestamp {
  if (typeof value !== "string" || !ISO_UTC_REGEX.test(value)) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  const iso = date.toISOString();
  return iso === value || iso.replace(".000Z", "Z") === value;
}

/**
 * Parses a string into a validated branded Timestamp, or throws a ValidationError.
 */
export function parseTimestamp(raw: string): Timestamp {
  if (!isTimestamp(raw)) {
    throw new ValidationError(`Invalid timestamp: "${raw}" is not a valid ISO-8601 UTC string`);
  }
  return raw as Timestamp;
}

/**
 * Converts a branded Timestamp into a standard Date object.
 */
export function timestampToDate(ts: Timestamp): Date {
  return new Date(ts);
}

/**
 * Converts a branded Timestamp into Unix epoch milliseconds.
 */
export function timestampToEpochMs(ts: Timestamp): number {
  return new Date(ts).getTime();
}

/**
 * Compares two Timestamps chronologically.
 * Returns -1 if a < b, 1 if a > b, and 0 if equal.
 */
export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Unsafely asserts that a string is a Timestamp (for trusted storage / test layers).
 */
export function asTimestamp(raw: string): Timestamp {
  return raw as Timestamp;
}
