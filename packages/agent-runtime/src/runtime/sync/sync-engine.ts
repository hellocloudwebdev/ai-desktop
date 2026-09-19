// PR45: packages/agent-runtime — SyncEngine (CORE ENGINE layer)
//
// Pure cross-device sync orchestration over injected ports. One SyncEngine
// owns exactly one timer (start()/stop() idempotent); every tick is:
//   push dirty (bounded, validated, tombstones included) -> cursor ->
//   pull since cursor -> validate remote (reject+count invalid, never apply)
//   -> LWW auto-merge for scalar prefs/metadata over the canonical
//   (version, updatedAt, deviceId) triple -> explicit conflicts for
//   schedule.definition/extension.metadata and every delete-vs-update ->
//   apply safe changes -> status.
//
// Composition rules:
//   - Canonical-first: record shape, conflict strategy, caps, secret/path
//     guards, and statuses come from @ai-desktop/ai-core
//     (SyncRecordSchema, resolveScalarConflict, classifySyncConflict,
//     buildSyncConflict, isProbablySecretField, isPathLookingValue,
//     MAX_SYNC_OUTBOX, MAX_SYNC_PAYLOAD_BYTES, MAX_TOMBSTONES,
//     TOMBSTONE_RETENTION_DAYS, MAX_SYNC_RETRIES, SYNC_TICK_MS_DEFAULT).
//     No local enum mirrors and no local validators duplicate them.
//   - Wire adaptation only: the injected SyncTransport speaks the wire
//     envelope from ./sync-transport.js (deleted flag, object payload, no
//     recordId). The engine converts canonical<->wire at that boundary and
//     validates both directions; conversion failures refuse, never transmit
//     or apply.
//   - Safety rails (all enforced here, tested):
//       * secret-shaped payloads are REFUSED outbound and rejected inbound
//         (never stored, never transmitted);
//       * project.metadata payloads carrying path-looking values are refused;
//       * inbound schedule.definition is FORCED to enabled=false with runs/
//         executions stripped, origin deviceId preserved; synced schedules
//         NEVER launch runs (this file imports no scheduler/background
//         manager and creates no runs);
//       * extension.metadata is INERT data (applied, never interpreted, no
//         hooks invoked);
//       * tombstone retention MAX_TOMBSTONES/30d is enforced on apply over
//         the engine ledger (durable pruning stays with the store).
//   - Failure mapping: transport "offline" -> status offline with the queue
//     retained (nothing marked clean); "auth-expired" -> status error
//     (the engine holds NO tokens and cannot refresh itself); "server-error"
//     -> retried up to MAX_SYNC_RETRIES with injectable backoff, then status
//     error. Storage-port throws -> status error; the tick never throws for
//     domain failures (the summary carries the outcome).
//   - Zero Electron, Prisma, child process spawn, filesystem, or network
//     imports. Time comes from an injectable clock.

import {
  buildSyncConflict,
  classifySyncConflict,
  createSyncRecordId,
  getSyncPayloadBytes,
  isProbablySecretField,
  isPathLookingValue,
  isSyncTombstone,
  MAX_SYNC_OUTBOX,
  MAX_SYNC_PAYLOAD_BYTES,
  MAX_SYNC_RETRIES,
  MAX_TOMBSTONES,
  resolveScalarConflict,
  SYNC_TICK_MS_DEFAULT,
  SyncRecordSchema,
  SyncStatusSchema,
  TOMBSTONE_RETENTION_DAYS,
  type SyncConflict,
  type SyncRecord,
  type SyncState,
  type SyncStatus,
} from "@ai-desktop/ai-core";
import {
  SYNC_PULL_LIMIT_DEFAULT,
  SyncTransportError,
  validateSyncRecordShape,
  type SyncRecord as WireSyncRecord,
  type SyncTransport,
} from "./sync-transport.js";

// ---------------------------------------------------------------------------
// Ports (structural; stores and transports are injected, never imported)
// ---------------------------------------------------------------------------

/** Durable sync persistence owned by the desktop/storage layer. */
export interface SyncEngineLocalStore {
  loadDirty(limit: number): Promise<SyncRecord[]>;
  markClean(records: readonly SyncRecord[]): Promise<void>;
  applyRemote(record: SyncRecord): Promise<void>;
  getCursor(): Promise<string>;
  setCursor(cursor: string): Promise<void>;
  listConflicts(): Promise<SyncConflict[]>;
  saveConflict(conflict: SyncConflict): Promise<void>;
}

export interface SyncEngineOptions {
  readonly localStore: SyncEngineLocalStore;
  readonly transport: SyncTransport;
  /** Owning account scope for push/pull calls (non-empty). */
  readonly accountId: string;
  /** Origin device id for echo suppression + LWW tie-breaks (non-empty). */
  readonly deviceId: string;
  readonly clock?: () => number;
  /** Tick interval ms (default canonical SYNC_TICK_MS_DEFAULT). */
  readonly tickMs?: number;
  /** Backoff ms before retry N (0-based); default bounded exponential. */
  readonly backoffMs?: (retryIndex: number) => number;
}

export interface SyncEngineTickSummary {
  readonly pushed: number;
  readonly pulled: number;
  readonly applied: number;
  readonly conflicts: number;
  /** Remote envelopes rejected by validation (never applied). */
  readonly invalid: number;
  /** Local dirty envelopes refused (never transmitted, kept dirty). */
  readonly refused: number;
  readonly offline: boolean;
  /** Fixed-token failure code when the tick did not complete cleanly. */
  readonly error?: string;
  /** Engine tombstone ledger size after retention. */
  readonly tombstones: number;
}

export class SyncEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[sync-engine:${code}] ${message}`);
    this.name = "SyncEngineError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MIN_TICK_MS = 10;
const DAY_MS = 86_400_000;

function defaultBackoffMs(retryIndex: number): number {
  return Math.min(250 * 2 ** retryIndex, 2000);
}

function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeKey(entityType: string, entityId: string): string {
  return `${entityType}::${entityId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when any object KEY (recursively) is secret-shaped (canonical). */
function payloadHasSecretKeys(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some(payloadHasSecretKeys);
  if (isPlainObject(payload)) {
    return Object.entries(payload).some(
      ([key, value]) => isProbablySecretField(key) || payloadHasSecretKeys(value),
    );
  }
  return false;
}

/** True when any string leaf (recursively) looks like a filesystem path. */
function payloadHasPaths(payload: unknown): boolean {
  if (typeof payload === "string") return isPathLookingValue(payload);
  if (Array.isArray(payload)) return payload.some(payloadHasPaths);
  if (isPlainObject(payload)) return Object.values(payload).some(payloadHasPaths);
  return false;
}

function sameEnvelope(a: SyncRecord, b: SyncRecord): boolean {
  if (a.version !== b.version || a.updatedAt !== b.updatedAt || a.deviceId !== b.deviceId) {
    return false;
  }
  try {
    return JSON.stringify(a.payload) === JSON.stringify(b.payload);
  } catch {
    return false;
  }
}

/**
 * Canonical -> wire envelope for push. Tombstones (deletedAt + null
 * payload) travel as { deleted: true, payload: {} }: the delete marker
 * propagates like any other version without moving payload bytes.
 */
function canonicalToWire(record: SyncRecord): WireSyncRecord {
  const tombstone = isSyncTombstone(record);
  const payload = tombstone ? {} : record.payload;
  if (!isPlainObject(payload)) {
    throw new SyncEngineError("refused", "sync payload must be an object for transport");
  }
  const wire: WireSyncRecord = {
    accountId: record.accountId,
    entityType: record.entityType,
    entityId: record.entityId,
    version: record.version,
    updatedAt: record.updatedAt,
    deviceId: record.deviceId,
    ...(tombstone ? { deleted: true } : {}),
    payload,
  };
  const checked = validateSyncRecordShape(wire);
  if (!checked.ok) {
    throw new SyncEngineError("refused", `sync envelope refused for transport: ${checked.reason}`);
  }
  return checked.record;
}

/**
 * Wire -> canonical fields for pull. The wire carries no recordId, so a
 * fresh canonical id is minted; tombstones (deleted flag) rebuild as
 * deletedAt + null payload.
 */
function wireToCanonicalFields(wire: WireSyncRecord): Record<string, unknown> {
  const deleted = wire.deleted === true;
  return {
    recordId: createSyncRecordId(),
    entityType: wire.entityType,
    entityId: wire.entityId,
    accountId: wire.accountId,
    deviceId: wire.deviceId,
    version: wire.version,
    updatedAt: wire.updatedAt,
    ...(deleted ? { deletedAt: wire.updatedAt } : {}),
    payload: deleted ? null : wire.payload,
  };
}

/**
 * Inbound schedule.definition sanitizer: synced definitions are inert until
 * locally enabled, so enabled is FORCED false and runs/executions are
 * stripped. Origin deviceId is preserved untouched.
 */
function sanitizeInboundSchedule(record: SyncRecord): SyncRecord {
  if (record.entityType !== "schedule.definition") return record;
  if (!isPlainObject(record.payload)) return record;
  const { runs: _runs, executions: _executions, ...rest } = record.payload;
  void _runs;
  void _executions;
  return { ...record, payload: { ...rest, enabled: false } };
}

// ---------------------------------------------------------------------------
// SyncEngine
// ---------------------------------------------------------------------------

export class SyncEngine {
  private readonly _store: SyncEngineLocalStore;
  private readonly _transport: SyncTransport;
  private readonly _accountId: string;
  private readonly _deviceId: string;
  private readonly _clock: () => number;
  private readonly _tickMs: number;
  private readonly _backoffMs: (retryIndex: number) => number;
  private readonly _known = new Map<string, SyncRecord>();
  private readonly _tombstoneSeen = new Map<string, number>();
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _tickPromise: Promise<SyncEngineTickSummary> | null = null;
  private _status: SyncStatus = { state: "idle", pendingChanges: 0, conflictCount: 0 };

  constructor(options: SyncEngineOptions) {
    if (!options || typeof options !== "object") {
      throw new SyncEngineError("invalid-options", "SyncEngine requires options");
    }
    if (!options.localStore || !options.transport) {
      throw new SyncEngineError("invalid-options", "SyncEngine requires localStore + transport");
    }
    const accountId = options.accountId?.trim() ?? "";
    const deviceId = options.deviceId?.trim() ?? "";
    if (accountId.length === 0 || deviceId.length === 0) {
      throw new SyncEngineError("invalid-options", "SyncEngine requires accountId + deviceId");
    }
    this._store = options.localStore;
    this._transport = options.transport;
    this._accountId = accountId;
    this._deviceId = deviceId;
    this._clock = options.clock ?? Date.now;
    this._tickMs =
      options.tickMs !== undefined && Number.isFinite(options.tickMs)
        ? Math.max(MIN_TICK_MS, Math.floor(options.tickMs))
        : SYNC_TICK_MS_DEFAULT;
    this._backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  get running(): boolean {
    return this._timer !== undefined;
  }

  getStatus(): SyncStatus {
    return { ...this._status };
  }

  /** Idempotent start: a second call while running is a no-op. */
  start(): void {
    if (this._timer !== undefined) return;
    this._timer = setInterval(() => {
      if (this._tickPromise !== null) return;
      void this.tick().catch(() => undefined);
    }, this._tickMs);
    const timer = this._timer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Idempotent stop: safe to call when not running. */
  stop(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * Single sync tick. Concurrent callers coalesce onto the in-flight tick.
   * Never throws for domain failures (transport offline/auth/retries,
   * invalid remotes, storage errors surface via status + summary).
   */
  tick(): Promise<SyncEngineTickSummary> {
    if (this._tickPromise !== null) return this._tickPromise;
    const run = this._tickOnce().finally(() => {
      if (this._tickPromise === run) this._tickPromise = null;
    });
    this._tickPromise = run;
    return run;
  }

  // -- tick ---------------------------------------------------------------

  private async _tickOnce(): Promise<SyncEngineTickSummary> {
    this._setStatus("syncing", {});
    const done = (partial: Omit<SyncEngineTickSummary, "tombstones">): SyncEngineTickSummary => ({
      ...partial,
      tombstones: this._tombstoneSeen.size,
    });

    let dirty: SyncRecord[];
    let cursor: string;
    try {
      dirty = await this._store.loadDirty(MAX_SYNC_OUTBOX);
      cursor = await this._store.getCursor();
    } catch {
      this._setStatus("error", { lastError: "storage-error" });
      return done({
        pushed: 0,
        pulled: 0,
        applied: 0,
        conflicts: 0,
        invalid: 0,
        refused: 0,
        offline: false,
        error: "storage-error",
      });
    }
    const dirtyList = Array.isArray(dirty) ? dirty.slice(0, MAX_SYNC_OUTBOX) : [];

    // Partition outbound: validate everything, transmit nothing secret,
    // oversized, path-bearing, or malformed. Refused envelopes stay dirty.
    const outbound: { canonical: SyncRecord; wire: WireSyncRecord }[] = [];
    let refused = 0;
    for (const candidate of dirtyList) {
      const wire = this._refuseOutbound(candidate);
      if (wire === null) {
        refused += 1;
        continue;
      }
      outbound.push({ canonical: candidate, wire });
    }

    let pushed = 0;
    try {
      if (outbound.length > 0) {
        const outcome = await this._withRetry(() =>
          this._transport.push({
            accountId: this._accountId,
            records: outbound.map((e) => e.wire),
          }),
        );
        const pushedRecords = outbound.map((e) => e.canonical);
        await this._store.markClean(pushedRecords);
        for (const record of pushedRecords) {
          const key = mergeKey(record.entityType, record.entityId);
          this._known.set(key, record);
          this._trackTombstone(key, record);
        }
        pushed = outbound.length;
        cursor = outcome.cursor;
        await this._store.setCursor(cursor);
      }
    } catch (err) {
      if (err instanceof SyncTransportError && err.code === "offline") {
        this._setStatus("offline", { pendingChanges: dirtyList.length });
        return done({
          pushed: 0,
          pulled: 0,
          applied: 0,
          conflicts: 0,
          invalid: 0,
          refused,
          offline: true,
          error: "offline",
        });
      }
      const code =
        err instanceof SyncTransportError && err.code === "auth-expired"
          ? "auth-expired"
          : "push-failed";
      this._setStatus("error", { lastError: code, pendingChanges: dirtyList.length });
      return done({
        pushed: 0,
        pulled: 0,
        applied: 0,
        conflicts: 0,
        invalid: 0,
        refused,
        offline: false,
        error: code,
      });
    }

    // Pull + merge.
    let pulled = 0;
    let applied = 0;
    let conflicts = 0;
    let invalid = 0;
    try {
      const outcome = await this._withRetry(() =>
        this._transport.pull({
          accountId: this._accountId,
          cursor,
          limit: SYNC_PULL_LIMIT_DEFAULT,
        }),
      );
      const remoteList = Array.isArray(outcome.records) ? outcome.records : [];
      pulled = remoteList.length;
      const knownConflicts = await this._store.listConflicts();
      for (const candidate of remoteList) {
        const remote = this._validateInbound(candidate);
        if (remote === null) {
          invalid += 1;
          continue;
        }
        const settled = await this._mergeRemote(remote, knownConflicts);
        if (settled === "applied") applied += 1;
        else if (settled === "conflict") conflicts += 1;
      }
      await this._store.setCursor(outcome.cursor);
    } catch (err) {
      if (err instanceof SyncTransportError && err.code === "offline") {
        this._setStatus("offline", { pendingChanges: dirtyList.length - pushed });
        return done({
          pushed,
          pulled,
          applied,
          conflicts,
          invalid,
          refused,
          offline: true,
          error: "offline",
        });
      }
      const code =
        err instanceof SyncTransportError && err.code === "auth-expired"
          ? "auth-expired"
          : "pull-failed";
      this._setStatus("error", { lastError: code, pendingChanges: dirtyList.length - pushed });
      return done({
        pushed,
        pulled,
        applied,
        conflicts,
        invalid,
        refused,
        offline: false,
        error: code,
      });
    }

    let conflictCount = 0;
    try {
      conflictCount = (await this._store.listConflicts()).length;
    } catch {
      this._setStatus("error", { lastError: "storage-error" });
      return done({
        pushed,
        pulled,
        applied,
        conflicts,
        invalid,
        refused,
        offline: false,
        error: "storage-error",
      });
    }

    this._setStatus(conflictCount > 0 ? "conflict" : "idle", {
      lastSyncedAt: new Date(this._clock()).toISOString(),
      pendingChanges: dirtyList.length - pushed,
      conflictCount,
    });
    return done({ pushed, pulled, applied, conflicts, invalid, refused, offline: false });
  }

  /** Retry helper: only transport "server-error" is retried (never offline/auth). */
  private async _withRetry<T>(op: () => Promise<T>): Promise<T> {
    let last: unknown = null;
    for (let attempt = 0; attempt <= MAX_SYNC_RETRIES; attempt++) {
      try {
        return await op();
      } catch (err) {
        last = err;
        const retryable = err instanceof SyncTransportError && err.code === "server-error";
        if (!retryable || attempt >= MAX_SYNC_RETRIES) throw err;
        await sleep(this._backoffMs(attempt));
      }
    }
    throw last;
  }

  /**
   * Outbound gate. Returns the wire envelope or null when the envelope must
   * be REFUSED (never transmitted, kept dirty, counted).
   */
  private _refuseOutbound(candidate: unknown): WireSyncRecord | null {
    const checked = SyncRecordSchema.safeParse(candidate);
    if (!checked.success) return null;
    const record = checked.data;
    try {
      if (getSyncPayloadBytes(record.payload) > MAX_SYNC_PAYLOAD_BYTES) return null;
    } catch {
      return null;
    }
    if (payloadHasSecretKeys(record.payload)) return null;
    if (record.entityType === "project.metadata" && payloadHasPaths(record.payload)) return null;
    try {
      return canonicalToWire(record);
    } catch {
      return null;
    }
  }

  /**
   * Inbound gate. Returns the sanitized canonical record or null when the
   * envelope must be REJECTED (counted invalid, never applied).
   */
  private _validateInbound(candidate: unknown): SyncRecord | null {
    const shape = validateSyncRecordShape(candidate);
    if (!shape.ok) return null;
    const canonical = SyncRecordSchema.safeParse(wireToCanonicalFields(shape.record));
    if (!canonical.success) return null;
    const record = canonical.data;
    if (payloadHasSecretKeys(record.payload)) return null;
    if (record.entityType === "project.metadata" && payloadHasPaths(record.payload)) return null;
    return sanitizeInboundSchedule(record);
  }

  /**
   * Merges one validated remote envelope. Returns "applied" when the store
   * was updated, "conflict" when an explicit conflict was recorded, or
   * "skipped" when already converged or locally newer.
   *
   * Ordering rule: different versions are ordered (newer wins, including
   * newer tombstones, which is how deletes propagate); same-version
   * divergence is concurrent and goes through classifySyncConflict
   * (delete-vs-update and schedule.definition/extension.metadata are always
   * explicit, scalar prefs/metadata resolve LWW over the triple).
   */
  private async _mergeRemote(
    remote: SyncRecord,
    knownConflicts: readonly SyncConflict[],
  ): Promise<"applied" | "conflict" | "skipped"> {
    const key = mergeKey(remote.entityType, remote.entityId);
    const local = this._known.get(key);
    if (local === undefined) {
      await this._store.applyRemote(remote);
      this._known.set(key, remote);
      this._trackTombstone(key, remote);
      return "applied";
    }
    if (sameEnvelope(local, remote)) return "skipped";

    if (remote.version !== local.version) {
      if (remote.version > local.version) {
        await this._store.applyRemote(remote);
        this._known.set(key, remote);
        this._trackTombstone(key, remote);
        return "applied";
      }
      return "skipped";
    }

    if (classifySyncConflict(local, remote) === "explicit") {
      const duplicate = knownConflicts.some(
        (c) =>
          c.entityType === remote.entityType &&
          c.entityId === remote.entityId &&
          c.localVersion === local.version &&
          c.remoteVersion === remote.version,
      );
      if (!duplicate) {
        await this._store.saveConflict(
          buildSyncConflict({
            local,
            remote,
            createdAt: new Date(this._clock()).toISOString(),
          }),
        );
      }
      return "conflict";
    }

    const winner = resolveScalarConflict(local, remote);
    if (winner === remote) {
      await this._store.applyRemote(remote);
      this._known.set(key, remote);
      this._trackTombstone(key, remote);
      return "applied";
    }
    return "skipped";
  }

  private _trackTombstone(key: string, record: SyncRecord): void {
    if (isSyncTombstone(record)) {
      const at = Date.parse(record.deletedAt ?? record.updatedAt);
      this._tombstoneSeen.set(key, Number.isFinite(at) ? at : this._clock());
    } else {
      this._tombstoneSeen.delete(key);
    }
    const cutoff = this._clock() - TOMBSTONE_RETENTION_DAYS * DAY_MS;
    for (const [seenKey, seenAt] of this._tombstoneSeen) {
      if (seenAt <= cutoff) this._tombstoneSeen.delete(seenKey);
    }
    if (this._tombstoneSeen.size > MAX_TOMBSTONES) {
      const ordered = [...this._tombstoneSeen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [seenKey] of ordered.slice(0, this._tombstoneSeen.size - MAX_TOMBSTONES)) {
        this._tombstoneSeen.delete(seenKey);
      }
    }
  }

  private _setStatus(state: SyncState, patch: Partial<SyncStatus>): void {
    const next: SyncStatus = {
      state,
      pendingChanges: patch.pendingChanges ?? this._status.pendingChanges,
      conflictCount: patch.conflictCount ?? this._status.conflictCount,
    };
    if (patch.lastSyncedAt !== undefined) next.lastSyncedAt = patch.lastSyncedAt;
    if (patch.lastError !== undefined) next.lastError = patch.lastError;
    // Structural guard so status snapshots always satisfy the canonical shape.
    this._status = SyncStatusSchema.parse(next);
  }
}
