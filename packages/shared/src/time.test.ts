import { describe, expect, it } from "vitest";
import {
  compareTimestamps,
  createTimestamp,
  isTimestamp,
  now,
  parseTimestamp,
  timestampToDate,
  timestampToEpochMs,
} from "./time.js";
import { ValidationError } from "./errors.js";

describe("time: Timestamp Creation and Format", () => {
  it("now() creates a valid ISO-8601 UTC timestamp ending in Z", () => {
    const ts = now();
    expect(typeof ts).toBe("string");
    expect(ts.endsWith("Z")).toBe(true);
    expect(isTimestamp(ts)).toBe(true);
  });

  it("createTimestamp normalizes Date, number, or ISO string to UTC ISO-8601", () => {
    const date = new Date("2026-09-06T12:00:00.000Z");
    const fromDate = createTimestamp(date);
    expect(fromDate).toBe("2026-09-06T12:00:00.000Z");

    const fromEpoch = createTimestamp(date.getTime());
    expect(fromEpoch).toBe("2026-09-06T12:00:00.000Z");

    const fromString = createTimestamp("2026-09-06T12:00:00.000Z");
    expect(fromString).toBe("2026-09-06T12:00:00.000Z");
  });

  it("throws ValidationError when creating timestamp from invalid source", () => {
    expect(() => createTimestamp("not-a-date")).toThrow(ValidationError);
    expect(() => createTimestamp(NaN)).toThrow(ValidationError);
  });
});

describe("time: Validation and Parsing", () => {
  it("isTimestamp returns true only for valid ISO-8601 UTC strings", () => {
    expect(isTimestamp("2026-09-06T15:30:00.000Z")).toBe(true);
    expect(isTimestamp("2026-09-06T15:30:00Z")).toBe(true);

    // Missing Z (not explicitly UTC)
    expect(isTimestamp("2026-09-06T15:30:00")).toBe(false);
    // Non-UTC offset
    expect(isTimestamp("2026-09-06T15:30:00+02:00")).toBe(false);
    // Bad format
    expect(isTimestamp("2026-13-45T99:99:99Z")).toBe(false);
    expect(isTimestamp(123456789)).toBe(false);
    expect(isTimestamp(null)).toBe(false);
  });

  it("parseTimestamp returns branded timestamp or throws ValidationError", () => {
    const valid = parseTimestamp("2026-09-06T15:30:00.000Z");
    expect(valid).toBe("2026-09-06T15:30:00.000Z");

    expect(() => parseTimestamp("bad-timestamp")).toThrow(ValidationError);
  });
});

describe("time: Conversion and Comparison", () => {
  it("converts Timestamp back to Date and epoch ms without precision loss", () => {
    const originalEpoch = 1788705800000;
    const ts = createTimestamp(originalEpoch);

    const date = timestampToDate(ts);
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBe(originalEpoch);

    const epoch = timestampToEpochMs(ts);
    expect(epoch).toBe(originalEpoch);
  });

  it("compares timestamps chronologically", () => {
    const earlier = createTimestamp("2026-09-06T10:00:00.000Z");
    const later = createTimestamp("2026-09-06T11:00:00.000Z");
    const same = createTimestamp("2026-09-06T10:00:00.000Z");

    expect(compareTimestamps(earlier, later)).toBe(-1);
    expect(compareTimestamps(later, earlier)).toBe(1);
    expect(compareTimestamps(earlier, same)).toBe(0);
  });
});
