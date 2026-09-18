// PR44: packages/agent-runtime — Schedule calculator unit tests
//
// Pure wall-clock math: once/delay/interval anchors, daily/weekly Intl
// resolution (Asia/Kolkata, DST gap + overlap), validation, and bounds.

import { describe, expect, it } from "vitest";
import {
  countDueOccurrences,
  initialOccurrenceMs,
  nextAfterHandledMs,
  nextPointerAfterNow,
  zonedTimeToUtc,
} from "../runtime/scheduling/schedule-calculator.js";

const HOUR = 3_600_000;

function wallIn(tz: string, ms: number): { hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: get("weekday") };
}

describe("schedule-calculator: once", () => {
  const runAt = "2026-09-19T09:30:00.000Z";
  const runAtMs = Date.parse(runAt);
  const q = { kind: "once" as const, config: { runAt }, timezone: "UTC" };

  it("fires exactly at runAt", () => {
    expect(initialOccurrenceMs({ ...q, createdAtMs: runAtMs - 1_000 })).toBe(runAtMs);
  });

  it("is consumed after handling (null next)", () => {
    expect(nextAfterHandledMs(q, runAtMs)).toBeNull();
  });

  it("counts due only inside (anchor, now]", () => {
    const base = { ...q, anchorMs: runAtMs - 10_000, consumed: false };
    expect(countDueOccurrences({ ...base, nowMs: runAtMs }).count).toBe(1);
    expect(countDueOccurrences({ ...base, nowMs: runAtMs - 1 }).count).toBe(0);
    expect(countDueOccurrences({ ...base, anchorMs: runAtMs, nowMs: runAtMs + 1 }).count).toBe(0);
    expect(countDueOccurrences({ ...base, consumed: true, nowMs: runAtMs + 1 }).count).toBe(0);
  });

  it("points at runAt while future, null once past", () => {
    expect(
      nextPointerAfterNow({ ...q, anchorMs: runAtMs - 10_000, consumed: false }, runAtMs - 1),
    ).toBe(runAtMs);
    expect(
      nextPointerAfterNow({ ...q, anchorMs: runAtMs - 10_000, consumed: false }, runAtMs),
    ).toBeNull();
    expect(
      nextPointerAfterNow({ ...q, anchorMs: runAtMs, consumed: true }, runAtMs + 1),
    ).toBeNull();
  });
});

describe("schedule-calculator: delay", () => {
  const createdAtMs = Date.parse("2026-09-18T00:00:00.000Z");
  const q = {
    kind: "delay" as const,
    config: { delayMs: HOUR },
    timezone: "UTC",
    createdAtMs,
  };

  it("converts delayMs to runAt at creation", () => {
    expect(initialOccurrenceMs(q)).toBe(createdAtMs + HOUR);
  });

  it("requires createdAtMs", () => {
    expect(() =>
      initialOccurrenceMs({ kind: "delay", config: { delayMs: HOUR }, timezone: "UTC" }),
    ).toThrow(/validation-error/);
  });

  it("is consumed after handling and counts a single due window", () => {
    expect(nextAfterHandledMs(q, createdAtMs + HOUR)).toBeNull();
    const due = countDueOccurrences({
      ...q,
      anchorMs: createdAtMs,
      nowMs: createdAtMs + HOUR + 1,
      consumed: false,
    });
    expect(due).toEqual({ count: 1, earliestMs: createdAtMs + HOUR, latestMs: createdAtMs + HOUR });
    expect(
      countDueOccurrences({
        ...q,
        anchorMs: createdAtMs,
        nowMs: createdAtMs + HOUR - 1,
        consumed: false,
      }).count,
    ).toBe(0);
  });

  it("rejects sub-minute delays by default, honours the test override", () => {
    expect(() =>
      initialOccurrenceMs({
        kind: "delay",
        config: { delayMs: 1_000 },
        timezone: "UTC",
        createdAtMs,
      }),
    ).toThrow(/validation-error/);
    expect(
      initialOccurrenceMs(
        { kind: "delay", config: { delayMs: 1_000 }, timezone: "UTC", createdAtMs },
        { minIntervalMs: 1_000 },
      ),
    ).toBe(createdAtMs + 1_000);
  });
});

describe("schedule-calculator: interval", () => {
  const createdAtMs = Date.parse("2026-09-18T00:00:00.000Z");
  const q = {
    kind: "interval" as const,
    config: { everyMs: HOUR },
    timezone: "UTC",
    createdAtMs,
  };

  it("anchors the first run one interval after creation", () => {
    expect(initialOccurrenceMs(q)).toBe(createdAtMs + HOUR);
    expect(nextAfterHandledMs(q, createdAtMs + HOUR)).toBe(createdAtMs + 2 * HOUR);
  });

  it("counts missed occurrences arithmetically (clock-jump safe)", () => {
    const due = countDueOccurrences({
      ...q,
      anchorMs: createdAtMs,
      nowMs: createdAtMs + 3 * HOUR + 10 * 60_000,
      consumed: false,
    });
    expect(due.count).toBe(3);
    expect(due.earliestMs).toBe(createdAtMs + HOUR);
    expect(due.latestMs).toBe(createdAtMs + 3 * HOUR);
  });

  it("stays exact over long outages (recompute-after-clock-jump)", () => {
    const anchor = Date.parse("2026-01-01T00:00:00.000Z");
    const now = Date.parse("2026-09-18T00:00:00.000Z");
    const due = countDueOccurrences({
      kind: "interval",
      config: { everyMs: 60_000 },
      timezone: "UTC",
      anchorMs: anchor,
      nowMs: now,
      consumed: false,
    });
    expect(due.count).toBe(Math.floor((now - anchor) / 60_000));
    expect(due.latestMs).toBe(anchor + due.count * 60_000);
  });

  it("returns zero when now is at or before the anchor", () => {
    expect(
      countDueOccurrences({ ...q, anchorMs: createdAtMs, nowMs: createdAtMs, consumed: false })
        .count,
    ).toBe(0);
    expect(
      countDueOccurrences({ ...q, anchorMs: createdAtMs + 1, nowMs: createdAtMs, consumed: false })
        .count,
    ).toBe(0);
  });

  it("points at the first occurrence strictly after now", () => {
    expect(nextPointerAfterNow({ ...q, anchorMs: createdAtMs, consumed: false }, createdAtMs)).toBe(
      createdAtMs + HOUR,
    );
    expect(
      nextPointerAfterNow({ ...q, anchorMs: createdAtMs, consumed: false }, createdAtMs + HOUR),
    ).toBe(createdAtMs + 2 * HOUR);
  });

  it("rejects `every 1 second` by default, honours the test override", () => {
    expect(() => initialOccurrenceMs({ ...q, config: { everyMs: 1_000 } })).toThrow(
      /validation-error/,
    );
    expect(initialOccurrenceMs({ ...q, config: { everyMs: 1_000 } }, { minIntervalMs: 1 })).toBe(
      createdAtMs + 1_000,
    );
  });
});

describe("schedule-calculator: daily (Intl wall-clock)", () => {
  it("fires at the wall-clock time in UTC", () => {
    const createdAtMs = Date.parse("2026-09-18T00:00:00.000Z");
    const next = initialOccurrenceMs({
      kind: "daily",
      config: { hour: 9, minute: 0 },
      timezone: "UTC",
      createdAtMs,
    });
    expect(next).toBe(Date.parse("2026-09-18T09:00:00.000Z"));
    const after = nextPointerAfterNow(
      {
        kind: "daily",
        config: { hour: 9, minute: 0 },
        timezone: "UTC",
        anchorMs: createdAtMs,
        consumed: false,
      },
      Date.parse("2026-09-18T10:00:00.000Z"),
    );
    expect(after).toBe(Date.parse("2026-09-19T09:00:00.000Z"));
  });

  it("resolves Asia/Kolkata wall-clock (+05:30, no DST)", () => {
    const createdAtMs = Date.parse("2026-09-18T00:00:00.000Z"); // 05:30 IST
    const next = initialOccurrenceMs({
      kind: "daily",
      config: { hour: 9, minute: 0 },
      timezone: "Asia/Kolkata",
      createdAtMs,
    });
    expect(next).toBe(Date.parse("2026-09-18T03:30:00.000Z"));
    expect(wallIn("Asia/Kolkata", next)).toMatchObject({ hour: 9, minute: 0 });
  });

  it("tolerates the spring-forward gap (fires at the next valid minute)", () => {
    // 2026-03-08 02:30 does not exist in America/New_York (02:00 -> 03:00).
    const createdAtMs = Date.parse("2026-03-07T12:00:00.000Z");
    const next = initialOccurrenceMs({
      kind: "daily",
      config: { hour: 2, minute: 30 },
      timezone: "America/New_York",
      createdAtMs,
    });
    expect(next).toBe(Date.parse("2026-03-08T07:00:00.000Z")); // 03:00 EDT
    expect(wallIn("America/New_York", next)).toMatchObject({ hour: 3, minute: 0 });
  });

  it("takes the first occurrence on fall-back overlap", () => {
    // 2026-11-01 01:30 happens twice in America/New_York; take the first (EDT).
    const createdAtMs = Date.parse("2026-10-31T12:00:00.000Z");
    const next = initialOccurrenceMs({
      kind: "daily",
      config: { hour: 1, minute: 30 },
      timezone: "America/New_York",
      createdAtMs,
    });
    expect(next).toBe(Date.parse("2026-11-01T05:30:00.000Z")); // 01:30 EDT
    expect(wallIn("America/New_York", next)).toMatchObject({ hour: 1, minute: 30 });
  });

  it("counts daily occurrences across a DST boundary", () => {
    const anchorMs = Date.parse("2026-03-07T15:00:00.000Z"); // after 09:00 EST
    const due = countDueOccurrences({
      kind: "daily",
      config: { hour: 9, minute: 0 },
      timezone: "America/New_York",
      anchorMs,
      nowMs: Date.parse("2026-03-09T14:00:00.000Z"),
      consumed: false,
    });
    // Mar 8 09:00 EDT (13:00Z) + Mar 9 09:00 EDT (13:00Z).
    expect(due.count).toBe(2);
    expect(due.earliestMs).toBe(Date.parse("2026-03-08T13:00:00.000Z"));
    expect(due.latestMs).toBe(Date.parse("2026-03-09T13:00:00.000Z"));
  });
});

describe("schedule-calculator: weekly", () => {
  it("fires on the next matching weekday", () => {
    const monday = Date.parse("2026-09-14T00:00:00.000Z");
    expect(new Date(monday).getUTCDay()).toBe(1);
    const next = initialOccurrenceMs({
      kind: "weekly",
      config: { weekday: 5, hour: 9, minute: 0 },
      timezone: "UTC",
      createdAtMs: monday,
    });
    const dt = new Date(next);
    expect(dt.getUTCDay()).toBe(5);
    expect(next).toBe(Date.parse("2026-09-18T09:00:00.000Z"));
  });

  it("fires same-day when the wall time is still ahead", () => {
    const fridayMorning = Date.parse("2026-09-18T07:00:00.000Z");
    const next = initialOccurrenceMs({
      kind: "weekly",
      config: { weekday: 5, hour: 9, minute: 0 },
      timezone: "UTC",
      createdAtMs: fridayMorning,
    });
    expect(next).toBe(Date.parse("2026-09-18T09:00:00.000Z"));
  });

  it("rolls to next week when today's occurrence already passed", () => {
    const fridayLate = Date.parse("2026-09-18T10:00:00.000Z");
    const next = initialOccurrenceMs({
      kind: "weekly",
      config: { weekday: 5, hour: 9, minute: 0 },
      timezone: "UTC",
      createdAtMs: fridayLate,
    });
    expect(next).toBe(Date.parse("2026-09-25T09:00:00.000Z"));
  });
});

describe("schedule-calculator: validation and bounds", () => {
  const createdAtMs = Date.parse("2026-09-18T00:00:00.000Z");

  it("rejects invalid timezones", () => {
    expect(() =>
      initialOccurrenceMs({
        kind: "daily",
        config: { hour: 9, minute: 0 },
        timezone: "Mars/Olympus",
        createdAtMs,
      }),
    ).toThrow(/validation-error/);
  });

  it("rejects kind/config mismatches", () => {
    expect(() =>
      initialOccurrenceMs({
        kind: "interval",
        config: { runAt: "2026-09-19T09:30:00.000Z" } as never,
        timezone: "UTC",
        createdAtMs,
      }),
    ).toThrow(/validation-error/);
  });

  it("rejects unbounded daily enumeration instead of hanging", () => {
    expect(() =>
      countDueOccurrences({
        kind: "daily",
        config: { hour: 9, minute: 0 },
        timezone: "UTC",
        anchorMs: Date.parse("2000-01-01T00:00:00.000Z"),
        nowMs: Date.parse("2026-09-18T00:00:00.000Z"),
        consumed: false,
      }),
    ).toThrow(/validation-error/);
  });

  it("resolves zoned wall times directly (Kolkata spot check)", () => {
    expect(zonedTimeToUtc("Asia/Kolkata", 2026, 1, 1, 9, 0)).toBe(
      Date.parse("2026-01-01T03:30:00.000Z"),
    );
    expect(() => zonedTimeToUtc("Nope/Zone", 2026, 1, 1, 9, 0)).toThrow(/validation-error/);
  });
});
