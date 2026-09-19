// PR45: packages/agent-runtime — Sync Queue Tests (CORE ENGINE layer)
//
// Bounded outbox coverage: capacity cap, newest-wins dedupe, FIFO drain,
// and serialize/restore round-trips with invalid-entry rejection.

import { describe, expect, it } from "vitest";
import {
  MAX_SYNC_OUTBOX,
  createAccountId,
  createDeviceId,
  createSyncRecordId,
  type SyncEntityType,
  type SyncRecord,
} from "@ai-desktop/ai-core";
import { compareSyncQueueOrder, SyncQueue, syncQueueKey } from "../runtime/sync/sync-queue.js";

const ACCOUNT = createAccountId();
const DEVICE_A = createDeviceId();
const DEVICE_B = createDeviceId();

function envelope(overrides: Partial<SyncRecord> = {}): SyncRecord {
  return {
    recordId: createSyncRecordId(),
    entityType: "app.settings",
    entityId: "theme",
    accountId: ACCOUNT,
    deviceId: DEVICE_A,
    version: 1,
    updatedAt: new Date(1_000).toISOString(),
    payload: { theme: "dark" },
    ...overrides,
  };
}

describe("sync-queue keys + ordering", () => {
  it("keys by entityType+entityId", () => {
    expect(syncQueueKey({ entityType: "app.settings", entityId: "theme" })).toBe(
      "app.settings::theme",
    );
  });

  it("orders by (version, updatedAt, deviceId) like resolveScalarConflict", () => {
    const base = envelope();
    expect(compareSyncQueueOrder({ ...base, version: 2 }, base)).toBeGreaterThan(0);
    expect(
      compareSyncQueueOrder(
        { ...base, updatedAt: new Date(2_000).toISOString() },
        { ...base, updatedAt: new Date(1_000).toISOString() },
      ),
    ).toBeGreaterThan(0);
    expect(compareSyncQueueOrder({ ...base, deviceId: DEVICE_B }, base)).not.toBe(0);
    expect(compareSyncQueueOrder(base, { ...base })).toBe(0);
  });
});

describe("SyncQueue bound + dedupe", () => {
  it("dedupes by entity keeping the newest envelope", () => {
    const queue = new SyncQueue();
    expect(queue.enqueue(envelope()).action).toBe("enqueued");
    // Older re-submit keeps the queued envelope (stable, no replacement).
    const older = envelope({ version: 1, updatedAt: new Date(500).toISOString() });
    expect(queue.enqueue(older).action).toBe("deduped-kept-existing");
    expect(queue.peek()).toHaveLength(1);
    expect(queue.peek()[0]?.updatedAt).toBe(new Date(1_000).toISOString());
    // Newer version replaces.
    const newer = envelope({ version: 2, updatedAt: new Date(500).toISOString() });
    expect(queue.enqueue(newer).action).toBe("deduped-kept-newest");
    expect(queue.peek()).toHaveLength(1);
    expect(queue.peek()[0]?.version).toBe(2);
  });

  it("caps at MAX_SYNC_OUTBOX evicting oldest-inserted first", () => {
    const queue = new SyncQueue();
    expect(queue.capacity).toBe(MAX_SYNC_OUTBOX);
    for (let i = 0; i < MAX_SYNC_OUTBOX; i++) {
      const outcome = queue.enqueue(
        envelope({ entityId: `entity-${i}`, recordId: createSyncRecordId() }),
      );
      expect(outcome.evicted).toBe(false);
    }
    expect(queue.size).toBe(MAX_SYNC_OUTBOX);
    const overflow = queue.enqueue(
      envelope({ entityId: "entity-new", recordId: createSyncRecordId() }),
    );
    expect(overflow).toMatchObject({ action: "enqueued", evicted: true });
    expect(queue.size).toBe(MAX_SYNC_OUTBOX);
    expect(queue.evictions).toBe(1);
    const ids = queue.peek().map((r) => r.entityId);
    expect(ids).not.toContain("entity-0");
    expect(ids).toContain("entity-new");
  });

  it("drains oldest-first with limit and clones without aliasing", () => {
    const queue = new SyncQueue();
    queue.enqueue(envelope({ entityId: "a" }));
    queue.enqueue(envelope({ entityId: "b" }));
    const drained = queue.drain(1);
    expect(drained.map((r) => r.entityId)).toEqual(["a"]);
    expect(queue.size).toBe(1);
    drained[0]!.payload = { hacked: true };
    expect(queue.peek()[0]?.entityId).toBe("b");
    queue.clear();
    expect(queue.size).toBe(0);
  });
});

describe("SyncQueue serialize/restore", () => {
  it("round-trips envelopes through JSON", () => {
    const queue = new SyncQueue();
    queue.enqueue(envelope({ entityId: "a" }));
    queue.enqueue(
      envelope({
        entityType: "schedule.definition" as SyncEntityType,
        entityId: "sched-1",
        payload: { enabled: false },
      }),
    );
    const snapshot = queue.serialize();
    const { queue: restored, outcome } = SyncQueue.restore(snapshot);
    expect(outcome).toEqual({ accepted: 2, rejected: 0 });
    expect(restored.size).toBe(2);
    expect(
      restored
        .peek()
        .map((r) => r.entityId)
        .sort(),
    ).toEqual(["a", "sched-1"]);
  });

  it("rejects invalid envelopes on restore and survives corrupt snapshots", () => {
    const snapshot = JSON.stringify({
      version: 1,
      records: [envelope({ entityId: "ok" }), { entityType: "nope", entityId: 42 }, null],
    });
    const { queue, outcome } = SyncQueue.restore(snapshot);
    expect(outcome).toEqual({ accepted: 1, rejected: 2 });
    expect(queue.peek().map((r) => r.entityId)).toEqual(["ok"]);
    const corrupt = SyncQueue.restore("not-json{{");
    expect(corrupt.outcome).toEqual({ accepted: 0, rejected: 0 });
    expect(corrupt.queue.size).toBe(0);
  });
});
