// PR45: packages/agent-runtime — Sync Outbox Queue (CORE ENGINE layer)
//
// Bounded in-memory outbox over canonical ai-core SyncRecords. The queue
// enforces the canonical MAX_SYNC_OUTBOX bound (200), dedupes by
// entityType+entityId keeping the newest envelope, and round-trips through
// JSON for persistence (restore validates every envelope against the
// canonical SyncRecordSchema and skips invalid entries).
//
// Composition rules:
//   - Canonical-first: record identity, ordering, and caps come from
//     @ai-desktop/ai-core (SyncRecord, SyncRecordSchema, MAX_SYNC_OUTBOX).
//     No local enum mirrors, no zod schemas defined here.
//   - Newest-wins dedupe compares the canonical (version, updatedAt,
//     deviceId) triple in the same direction as resolveScalarConflict
//     (higher version wins; later updatedAt wins ties; lexicographically
//     smaller deviceId wins full ties); a strictly-newer incoming envelope
//     replaces the queued one, otherwise the queued one is kept (stable).
//   - Overflow evicts the oldest-inserted envelope (FIFO) and counts the
//     eviction; eviction is reported, never silent.
//   - Zero Electron, Prisma, child process spawn, filesystem, or network
//     imports. No timers, no transport, no secret material.

import { MAX_SYNC_OUTBOX, SyncRecordSchema, type SyncRecord } from "@ai-desktop/ai-core";

/** Queue identity: one envelope per syncable entity. */
export function syncQueueKey(record: {
  readonly entityType: string;
  readonly entityId: string;
}): string {
  return `${record.entityType}::${record.entityId}`;
}

/**
 * Compares two envelopes over the canonical (version, updatedAt, deviceId)
 * triple. Returns >0 when `a` is newer, <0 when `b` is newer, 0 when tied.
 * Same direction as canonical resolveScalarConflict.
 */
export function compareSyncQueueOrder(a: SyncRecord, b: SyncRecord): number {
  if (a.version !== b.version) return a.version > b.version ? 1 : -1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? 1 : -1;
  if (a.deviceId !== b.deviceId) return a.deviceId > b.deviceId ? 1 : -1;
  return 0;
}

/** Deep-clones a JSON-safe envelope so the queue never aliases caller memory. */
function cloneEnvelope(record: SyncRecord): SyncRecord {
  return JSON.parse(JSON.stringify(record)) as SyncRecord;
}

export type SyncQueueEnqueueAction = "enqueued" | "deduped-kept-newest" | "deduped-kept-existing";

export interface SyncQueueEnqueueOutcome {
  readonly action: SyncQueueEnqueueAction;
  /** True when an oldest-inserted envelope was evicted to respect the cap. */
  readonly evicted: boolean;
  readonly size: number;
}

export interface SyncQueueRestoreOutcome {
  readonly accepted: number;
  readonly rejected: number;
}

/**
 * Bounded outbox queue for canonical sync envelopes. Insertion-ordered;
 * drain() removes oldest-first up to an optional limit.
 */
export class SyncQueue {
  private readonly _items = new Map<string, SyncRecord>();
  private _evictions = 0;

  get size(): number {
    return this._items.size;
  }

  get evictions(): number {
    return this._evictions;
  }

  /** Maximum envelopes held (canonical MAX_SYNC_OUTBOX). */
  get capacity(): number {
    return MAX_SYNC_OUTBOX;
  }

  /**
   * Enqueues one envelope. Same-entity envelopes dedupe keeping the newest
   * triple; overflow evicts the oldest-inserted envelope.
   */
  enqueue(record: SyncRecord): SyncQueueEnqueueOutcome {
    const key = syncQueueKey(record);
    const existing = this._items.get(key);
    if (existing !== undefined) {
      if (compareSyncQueueOrder(record, existing) > 0) {
        // Refresh recency: newest moves to the back of the FIFO.
        this._items.delete(key);
        this._items.set(key, cloneEnvelope(record));
        return { action: "deduped-kept-newest", evicted: false, size: this._items.size };
      }
      return { action: "deduped-kept-existing", evicted: false, size: this._items.size };
    }
    let evicted = false;
    if (this._items.size >= MAX_SYNC_OUTBOX) {
      const oldest = this._items.keys().next();
      if (!oldest.done) {
        this._items.delete(oldest.value);
        this._evictions += 1;
        evicted = true;
      }
    }
    this._items.set(key, cloneEnvelope(record));
    return { action: "enqueued", evicted, size: this._items.size };
  }

  /** Oldest-first snapshot without removing (cloned, no caller aliasing). */
  peek(): SyncRecord[] {
    return [...this._items.values()].map(cloneEnvelope);
  }

  /**
   * Removes and returns up to `limit` envelopes, oldest-first. Defaults to
   * the canonical outbox bound (one tick's worth of push).
   */
  drain(limit: number = MAX_SYNC_OUTBOX): SyncRecord[] {
    const take = Math.max(0, Math.min(Math.floor(limit), this._items.size));
    const out: SyncRecord[] = [];
    for (const [key, record] of this._items) {
      if (out.length >= take) break;
      this._items.delete(key);
      out.push(cloneEnvelope(record));
    }
    return out;
  }

  clear(): void {
    this._items.clear();
  }

  /** JSON snapshot `{ version: 1, records: [...] }` for durable persistence. */
  serialize(): string {
    return JSON.stringify({ version: 1, records: [...this._items.values()] });
  }

  /**
   * Restores a queue from a serialize() snapshot. Every envelope is
   * validated against the canonical SyncRecordSchema; invalid entries are
   * skipped and counted, never restored. Overflow keeps the newest
   * envelopes (oldest-inserted evicted first).
   */
  static restore(snapshot: string): { queue: SyncQueue; outcome: SyncQueueRestoreOutcome } {
    const queue = new SyncQueue();
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshot) as unknown;
    } catch {
      return { queue, outcome: { accepted: 0, rejected: 0 } };
    }
    const records =
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { records?: unknown }).records)
        ? ((parsed as { records: unknown[] }).records as unknown[])
        : [];
    let accepted = 0;
    let rejected = 0;
    const valid: SyncRecord[] = [];
    for (const candidate of records) {
      const checked = SyncRecordSchema.safeParse(candidate);
      if (!checked.success) {
        rejected += 1;
        continue;
      }
      valid.push(checked.data);
    }
    // Newest-first so overflow eviction drops the oldest-inserted tail.
    valid.sort((a, b) => compareSyncQueueOrder(b, a));
    for (const record of valid.reverse()) {
      queue.enqueue(record);
      accepted += 1;
    }
    return { queue, outcome: { accepted, rejected } };
  }
}
