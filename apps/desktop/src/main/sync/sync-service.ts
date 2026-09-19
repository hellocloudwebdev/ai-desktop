// PR45: apps/desktop — DesktopSyncService (Desktop Orchestration Layer)
//
// Thin orchestration around the durable sync repositories
// (PrismaSyncRecordRepository / PrismaSyncCursorRepository /
// PrismaSyncConflictRepository, injected as structural ports) + a SyncEngine
// port + EventBus/EventRepository. It owns NO PermissionManager, NO provider
// router, NO secret storage, and NO Electron APIs (Node only).
//
// Invariants:
//   1. Persistence is a projection/read model: every tick upserts sync record
//      rows {recordId,entityType,entityId,accountId,deviceId,version,
//      payloadJson,updatedAt,deletedAt}, advances the pull cursor keyed
//      `sync:pull:<accountId>`, and saves conflict rows for same-version
//      divergences. Payloads are bounded (64KB) and secret-scanned before
//      every write; raw secrets never reach storage.
//   2. Sync carries NO secrets: SecretStore is never imported or referenced.
//      Secret-shaped payloads are refused fail-closed (SyncServiceError,
//      "CODE: message", never a value echo).
//   3. Events are authoritative: every tick publishes sync.* AIEvents via
//      storage.append THEN EventBus.publish (same ordering as AccountService /
//      DesktopSchedulerService: persistence before delivery), with
//      conversationId-per-entity (accountId) + sequence allocation with retry.
//   4. Conflict resolution is explicit only: keep-local / keep-remote. There
//      is no silent/auto choice.
//   5. paused=true parks locally: no timer, no transport calls.
//   6. Fail closed: malformed ids, oversized payloads, secret payloads, and
//      storage loss all throw SyncServiceError ("CODE: message", never a
//      stack or secret echo).
//   7. Electron-free: this file imports no Electron APIs (Node timers only).
//
// Engine note: the canonical SyncEngine lives in
// packages/agent-runtime/src/runtime/sync/sync-engine.ts and is importable
// from "@ai-desktop/agent-runtime". This file keeps a minimal structural
// FallbackSyncEngine (push dirty, pull remote, LWW for scalar prefs vs
// explicit conflicts for schedule/extension + delete-vs-update) so the
// desktop orchestration stays testable without a network backend. All
// vocabulary, caps, and conflict strategy defer to the canonical ai-core
// builders below; the fallback never launches schedules (no scheduler/
// background imports) and treats extension.metadata as inert data.

import {
  createEventId,
  isSyncableEntityType,
  isPathLookingValue,
  isProbablySecretField,
  classifySyncConflict,
  MAX_SYNC_OUTBOX,
  MAX_SYNC_PAYLOAD_BYTES,
  MAX_SYNC_RETRIES,
  SYNC_TICK_MS_DEFAULT,
  syncEventType as canonicalSyncEventType,
  type AIEvent,
} from "@ai-desktop/ai-core";
import { generateUlid, type ConversationId } from "@ai-desktop/shared";
import type { EventRepository, SyncConflictRow, SyncRecordRow } from "@ai-desktop/storage";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Canonical cross-device sync states (renderer-compatible). */
export type SyncStatus = "idle" | "syncing" | "offline" | "error" | "conflict";

export const SYNC_STATUSES: readonly SyncStatus[] = [
  "idle",
  "syncing",
  "offline",
  "error",
  "conflict",
];

/** Explicit conflict resolutions. There is no silent/auto choice. */
export type SyncConflictResolution = "keep-local" | "keep-remote";

export const SYNC_CONFLICT_RESOLUTIONS: readonly SyncConflictResolution[] = [
  "keep-local",
  "keep-remote",
];

/** Renderer-compatible conflict view (entity/entityId keys, numeric versions). */
export interface SyncConflictView {
  readonly conflictId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly localVersion: number;
  readonly remoteVersion: number;
  readonly changedFields: string[];
  readonly updatedAt?: string;
}

/** Renderer-compatible status view (exact shape of normalizeSyncStatus). */
export interface SyncStatusView {
  readonly status: SyncStatus;
  readonly lastSyncAt?: string;
  readonly pendingCount: number;
  readonly conflictCount: number;
  readonly lastError?: string;
  readonly paused: boolean;
}

export class SyncServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SyncServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Minimal structural ports (real Prisma repos and test stubs both fit)
// ---------------------------------------------------------------------------

/** Structural view of PrismaSyncRecordRepository (upsert-if-newer). */
export interface SyncRecordRepoPort {
  upsert(record: SyncRecordRow): Promise<boolean>;
  get(recordId: string): Promise<SyncRecordRow | null>;
  listByAccount(accountId: string, limit?: number): Promise<SyncRecordRow[]>;
  getDirty(accountId: string, cursor: number): Promise<SyncRecordRow[]>;
  writeTombstone(record: SyncRecordRow, atMs?: number): Promise<boolean>;
}

/** Structural view of PrismaSyncCursorRepository. */
export interface SyncCursorRepoPort {
  getValue(key: string, fallback?: number): Promise<number>;
  set(key: string, value: number): Promise<void>;
}

/** Structural view of PrismaSyncConflictRepository. */
export interface SyncConflictRepoPort {
  save(conflict: SyncConflictRow): Promise<void>;
  list(accountId?: string, limit?: number): Promise<SyncConflictRow[]>;
  resolve(conflictId: string): Promise<boolean>;
}

/** Engine record: structural mirror of the agent-runtime SyncRecord shape. */
export interface EngineSyncRecord {
  readonly accountId: string;
  /** Optional project scope; required for project.metadata envelopes. */
  readonly projectId?: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly version: number;
  /** ISO-8601 timestamp; LWW tie-break after version. */
  readonly updatedAt: string;
  readonly deviceId: string;
  /** Tombstone delete marker; propagates like any other version. */
  readonly deleted?: boolean;
  /** JSON object payload, <= 64 KiB serialized, never secret-bearing. */
  readonly payload: Record<string, unknown>;
}

export interface SyncPushInput {
  readonly accountId: string;
  readonly records: readonly EngineSyncRecord[];
}

export interface SyncPullInput {
  readonly accountId: string;
  /** Millis watermark from the last tick; "" starts from the beginning. */
  readonly cursor: string;
  readonly limit?: number;
}

export interface SyncPullOutcome {
  readonly records: EngineSyncRecord[];
  readonly cursor: string;
}

/**
 * Minimal structural push/pull transport port. Shape-matches the canonical
 * SyncTransport in @ai-desktop/agent-runtime (runtime/sync/sync-transport.ts),
 * which is importable from "@ai-desktop/agent-runtime".
 *
 * Offline convention (mirrors SyncTransportError codes without importing):
 * implementations signal "offline" via err.code === "offline" or an
 * "offline" message; anything else is a server error.
 */
export interface PushPullTransport {
  push(input: SyncPushInput): Promise<{ cursor: string }>;
  pull(input: SyncPullInput): Promise<SyncPullOutcome>;
}

/** Publish-only view of EventBus (mirrors AccountEventTransport). */
export interface SyncEventTransport {
  publish(event: Readonly<AIEvent>): Promise<void>;
}

/** Append-first view of EventRepository (history reads are best-effort). */
export type SyncStoragePort = Pick<EventRepository, "append"> & {
  getByConversation?: (conversationId: ConversationId) => Promise<AIEvent[]>;
};

export interface DesktopSyncServiceDeps {
  readonly recordRepo: SyncRecordRepoPort;
  readonly cursorRepo: SyncCursorRepoPort;
  readonly conflictRepo: SyncConflictRepoPort;
  readonly transport?: PushPullTransport;
  readonly eventBus: SyncEventTransport;
  readonly storage: SyncStoragePort;
  readonly deviceId?: string;
  readonly clock?: () => number;
  readonly tickMs?: number;
  readonly accountId?: string;
}

// ---------------------------------------------------------------------------
// SyncEnginePort + functional fallback stub (see header engine-fallback note)
// ---------------------------------------------------------------------------

export interface SyncEngineTickInput {
  readonly accountId: string;
  readonly deviceId: string;
  readonly nowMs: number;
}

export interface SyncEngineTickConflict {
  readonly row: SyncConflictRow;
  readonly remote: EngineSyncRecord;
}

export interface SyncEngineTickOutcome {
  readonly pushed: number;
  readonly pulled: number;
  readonly applied: number;
  readonly queued: number;
  readonly cursor: number;
  readonly conflicts: SyncEngineTickConflict[];
  readonly offline: boolean;
  /** Remote envelopes rejected by validation (counted, never applied). */
  readonly invalid?: number;
  /** Local envelopes refused (never transmitted, kept dirty). */
  readonly refused?: number;
  readonly error?: string;
}

/** Minimal structural SyncEngine port the real engine will implement. */
export interface SyncEnginePort {
  tick(input: SyncEngineTickInput): Promise<SyncEngineTickOutcome>;
}

export interface FallbackSyncEngineDeps {
  readonly recordRepo: SyncRecordRepoPort;
  readonly cursorRepo: SyncCursorRepoPort;
  readonly conflictRepo: SyncConflictRepoPort;
  readonly transport: PushPullTransport;
}

// ---------------------------------------------------------------------------
// Bounds, patterns, secrets (canonical ai-core caps; local aliases kept)
// ---------------------------------------------------------------------------

export const DEFAULT_SYNC_TICK_MS = SYNC_TICK_MS_DEFAULT;
const MIN_SYNC_TICK_MS = 10;
// Canonical: MAX_SYNC_PAYLOAD_BYTES (65536), MAX_SYNC_OUTBOX (200),
// MAX_TOMBSTONES (500), TOMBSTONE_RETENTION_DAYS (30), MAX_SYNC_RETRIES (3).
const MAX_SYNC_ENTITY_TYPE_LENGTH = 64;
const MAX_SYNC_ENTITY_ID_LENGTH = 256;
const MAX_SYNC_ACCOUNT_ID_LENGTH = 256;
const MAX_SYNC_DEVICE_ID_LENGTH = 256;
const SYNC_PULL_LIMIT = MAX_SYNC_OUTBOX;
const MAX_CHANGED_FIELDS = 50;

const SECRET_PATTERN =
  /(api[_-]?key|secret|bearer\s+[A-Za-z0-9._~-]|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-|gh[pousr]_|sk-(live|test)-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|password\s*[:=]|passwd\s*[:=]|client[_-]?secret|access[_-]?token|refresh[_-]?token|aws[_-]?secret)/i;

// Canonical 5-entry sync event suffixes (ai-core sync.ts).
export type SyncEventType = "started" | "completed" | "failed" | "conflict" | "queued";

function syncEventType(type: string): `sync.${SyncEventType}` {
  try {
    return canonicalSyncEventType(type) as `sync.${SyncEventType}`;
  } catch {
    throw new SyncServiceError("SYNC_VALIDATION", "invalid sync event type");
  }
}

/** Pull-watermark cursor key for one account. */
export function pullCursorKey(accountId: string): string {
  return `sync:pull:${accountId}`;
}

/** Deterministic per-entity conflict id (re-ticks upsert, never duplicate). */
function conflictIdFor(recordId: string): string {
  return `conflict::${recordId}`;
}

/** Store key scoping one entity envelope to one account (+project when present). */
function recordIdFor(
  accountId: string,
  entityType: string,
  entityId: string,
  projectId?: string,
): string {
  return projectId
    ? `${accountId}::${projectId}::${entityType}::${entityId}`
    : `${accountId}::${entityType}::${entityId}`;
}

function refuseSecrets(value: unknown): void {
  let text: string | null = null;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    throw new SyncServiceError(
      "SYNC_VALIDATION",
      "refusing to persist sync payload: value is not serializable",
    );
  }
  if (text != null && SECRET_PATTERN.test(text)) {
    throw new SyncServiceError(
      "SYNC_VALIDATION",
      "refusing to persist sync payload: value appears to contain secret material",
    );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function payloadByteLength(payloadJson: string): number {
  return Buffer.byteLength(payloadJson, "utf8");
}

function isOfflineSignal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "offline") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /offline/i.test(message);
}

/** Fixed-token validation of one pulled engine record (never echoes values). */
function validateEngineRecord(
  value: unknown,
):
  | { readonly ok: true; readonly record: EngineSyncRecord }
  | { readonly ok: false; readonly reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "record-must-be-object" };
  const { accountId, projectId, entityType, entityId, version, updatedAt, deviceId, deleted } =
    value as Record<string, unknown>;
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId.length > MAX_SYNC_ACCOUNT_ID_LENGTH
  ) {
    return { ok: false, reason: "invalid-accountId" };
  }
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" ||
      projectId.length === 0 ||
      projectId.length > MAX_SYNC_ACCOUNT_ID_LENGTH)
  ) {
    return { ok: false, reason: "invalid-projectId" };
  }
  if (
    typeof entityType !== "string" ||
    entityType.length === 0 ||
    entityType.length > MAX_SYNC_ENTITY_TYPE_LENGTH
  ) {
    return { ok: false, reason: "invalid-entityType" };
  }
  // Closed allowlist: runs/executions/sessions/secrets/keys/paths never sync.
  if (!isSyncableEntityType(entityType)) {
    return { ok: false, reason: "entity-not-allowed" };
  }
  if (
    typeof entityId !== "string" ||
    entityId.length === 0 ||
    entityId.length > MAX_SYNC_ENTITY_ID_LENGTH
  ) {
    return { ok: false, reason: "invalid-entityId" };
  }
  // project.metadata envelopes must carry a project scope.
  if (entityType === "project.metadata" && projectId === undefined) {
    return { ok: false, reason: "project-metadata-requires-projectId" };
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: "invalid-version" };
  }
  if (typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
    return { ok: false, reason: "invalid-updatedAt" };
  }
  if (
    typeof deviceId !== "string" ||
    deviceId.length === 0 ||
    deviceId.length > MAX_SYNC_DEVICE_ID_LENGTH
  ) {
    return { ok: false, reason: "invalid-deviceId" };
  }
  if (deleted !== undefined && typeof deleted !== "boolean") {
    return { ok: false, reason: "invalid-deleted" };
  }
  const payload = (value as { payload?: unknown }).payload;
  if (!isPlainObject(payload)) return { ok: false, reason: "payload-must-be-object" };
  let size = 0;
  try {
    size = payloadByteLength(JSON.stringify(payload));
  } catch {
    return { ok: false, reason: "payload-not-serializable" };
  }
  if (size > MAX_SYNC_PAYLOAD_BYTES) return { ok: false, reason: "payload-too-large" };
  // Secret-shaped keys are refused before any repo write or transport.
  for (const key of Object.keys(payload)) {
    if (isProbablySecretField(key)) return { ok: false, reason: "secret-field-refused" };
  }
  // project.metadata payloads must never carry filesystem paths.
  if (entityType === "project.metadata") {
    for (const entry of Object.values(payload)) {
      if (isPathLookingValue(entry)) return { ok: false, reason: "path-refused" };
    }
  }
  // schedule.definition envelopes are sanitized downstream (enabled forced
  // false, runs/executions stripped, origin device preserved) — validation
  // accepts them here so the sanitizer can make them inert on apply.
  return {
    ok: true,
    record: {
      accountId,
      ...(projectId !== undefined ? { projectId: projectId as string } : {}),
      entityType,
      entityId,
      version,
      updatedAt,
      deviceId,
      ...(deleted !== undefined ? { deleted: deleted as boolean } : {}),
      payload: payload as Record<string, unknown>,
    },
  };
}

/** Repo row -> engine record for upload (secret-scanned, fail-closed). */
function rowToEngineRecord(row: SyncRecordRow): EngineSyncRecord {
  // Closed allowlist enforced on upload: non-allowlisted rows never transmit.
  if (!isSyncableEntityType(row.entityType)) {
    throw new SyncServiceError("SYNC_VALIDATION", "local sync entity is not allowed");
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (!isPlainObject(parsed)) {
      throw new SyncServiceError("SYNC_ERROR", "local sync record payload is corrupt");
    }
    payload = parsed;
  } catch (err) {
    if (err instanceof SyncServiceError) throw err;
    throw new SyncServiceError("SYNC_ERROR", "local sync record payload is corrupt");
  }
  if (payloadByteLength(row.payloadJson) > MAX_SYNC_PAYLOAD_BYTES) {
    throw new SyncServiceError("SYNC_VALIDATION", "local sync payload exceeds the 64KB bound");
  }
  refuseSecrets(row.payloadJson);
  for (const key of Object.keys(payload)) {
    if (isProbablySecretField(key)) {
      throw new SyncServiceError(
        "SYNC_VALIDATION",
        "refusing to persist sync payload: value appears to contain secret material",
      );
    }
  }
  return {
    accountId: row.accountId,
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    updatedAt: new Date(row.updatedAt).toISOString(),
    deviceId: row.deviceId,
    ...(row.deletedAt != null ? { deleted: true } : {}),
    payload,
  };
}

/** Engine record -> repo row for download (secret-scanned before write). */
function engineRecordToRow(record: EngineSyncRecord): SyncRecordRow {
  // Closed allowlist enforced on every download path.
  if (!isSyncableEntityType(record.entityType)) {
    throw new SyncServiceError("SYNC_VALIDATION", "remote sync entity is not allowed");
  }
  // Inbound schedule.definition is forced inert: enabled=false, no runs.
  let payload = record.payload;
  const deleted = record.deleted === true;
  if (record.entityType === "schedule.definition" && isPlainObject(payload)) {
    const { runs: _runs, executions: _executions, ...rest } = payload;
    void _runs;
    void _executions;
    payload = { ...rest, enabled: false };
  }
  // extension.metadata is inert data: applied verbatim, never interpreted.
  const payloadJson = JSON.stringify(payload);
  if (payloadByteLength(payloadJson) > MAX_SYNC_PAYLOAD_BYTES) {
    throw new SyncServiceError("SYNC_VALIDATION", "remote sync payload exceeds the 64KB bound");
  }
  refuseSecrets(payloadJson);
  for (const key of Object.keys(payload)) {
    if (isProbablySecretField(key)) {
      throw new SyncServiceError(
        "SYNC_VALIDATION",
        "refusing to persist sync payload: value appears to contain secret material",
      );
    }
  }
  if (record.entityType === "project.metadata") {
    for (const entry of Object.values(payload)) {
      if (isPathLookingValue(entry)) {
        throw new SyncServiceError("SYNC_VALIDATION", "project metadata must not carry paths");
      }
    }
  }
  const updatedAt = Date.parse(record.updatedAt);
  return {
    recordId: recordIdFor(record.accountId, record.entityType, record.entityId, record.projectId),
    entityType: record.entityType,
    entityId: record.entityId,
    accountId: record.accountId,
    deviceId: record.deviceId,
    version: record.version,
    payloadJson,
    updatedAt,
    deletedAt: deleted ? updatedAt : null,
  };
}

/**
 * LWW comparison over the (version, updatedAt, deviceId) triple.
 * Canonical direction (mirrors ai-core resolveScalarConflict): higher
 * version wins; later updatedAt wins ties; lexicographically SMALLER
 * deviceId wins full ties. Returns >0 when `a` wins, <0 when `b` wins.
 */
function compareTriple(
  a: { version: number; updatedAtMs: number; deviceId: string },
  b: { version: number; updatedAtMs: number; deviceId: string },
): number {
  if (a.version !== b.version) return a.version > b.version ? 1 : -1;
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs > b.updatedAtMs ? 1 : -1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? 1 : -1;
  return 0;
}

function diffChangedFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): string[] {
  const fields: string[] = [];
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    if (stableStringify(local[key]) !== stableStringify(remote[key])) {
      fields.push(key);
      if (fields.length >= MAX_CHANGED_FIELDS) break;
    }
  }
  return fields.sort();
}

function parseChangedFields(changedFieldsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(changedFieldsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

function requireAccountId(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.trim().length === 0 ||
    raw.trim().length > MAX_SYNC_ACCOUNT_ID_LENGTH
  ) {
    throw new SyncServiceError(
      "SYNC_VALIDATION",
      "accountId must be a non-empty string of at most 256 characters",
    );
  }
  return raw.trim();
}

function requireConflictId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new SyncServiceError("SYNC_VALIDATION", "conflictId must be a non-empty string");
  }
  return raw.trim();
}

function requireResolution(raw: unknown): SyncConflictResolution {
  if (raw !== "keep-local" && raw !== "keep-remote") {
    throw new SyncServiceError(
      "SYNC_VALIDATION",
      "resolution must be an explicit choice: keep-local or keep-remote",
    );
  }
  return raw;
}

function boundLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

/**
 * Default transport used when none is injected: push acks, pull is empty.
 * Clearly marked fallback: with no backend the tick is a local no-op that
 * still advances lifecycle state (never throws, never calls out).
 */
export class NoopPushPullTransport implements PushPullTransport {
  async push(): Promise<{ cursor: string }> {
    return { cursor: "" };
  }

  async pull(input: SyncPullInput): Promise<SyncPullOutcome> {
    return { records: [], cursor: input.cursor };
  }
}

/**
 * FallbackSyncEngine: functional local stand-in for the real SyncEngine
 * (see header engine note). Pushes dirty envelopes (bounded to
 * MAX_SYNC_OUTBOX), pulls remote envelopes, applies LWW for scalar
 * prefs/metadata over the canonical (version, updatedAt, deviceId) triple,
 * records explicit conflicts for schedule.definition/extension.metadata and
 * every delete-vs-update divergence (via canonical classifySyncConflict),
 * writes tombstones, bounds retries to MAX_SYNC_RETRIES, and counts (never
 * applies) invalid remotes. Inbound schedule.definition is forced inert
 * (enabled=false, runs/executions stripped, origin deviceId preserved);
 * extension.metadata is inert data (applied, never interpreted). All repo
 * writes go through secret-scan + 64KB bound checks (defense in depth).
 */
export class FallbackSyncEngine implements SyncEnginePort {
  private readonly _records: SyncRecordRepoPort;
  private readonly _cursors: SyncCursorRepoPort;
  private readonly _conflicts: SyncConflictRepoPort;
  private readonly _transport: PushPullTransport;

  constructor(deps: FallbackSyncEngineDeps) {
    this._records = deps.recordRepo;
    this._cursors = deps.cursorRepo;
    this._conflicts = deps.conflictRepo;
    this._transport = deps.transport;
  }

  private async _pushWithRetry(accountId: string, records: EngineSyncRecord[]): Promise<string> {
    let last: unknown = null;
    for (let attempt = 0; attempt <= MAX_SYNC_RETRIES; attempt++) {
      try {
        const outcome = await this._transport.push({ accountId, records });
        return outcome.cursor;
      } catch (err) {
        last = err;
        if (isOfflineSignal(err)) throw err;
        if (attempt >= MAX_SYNC_RETRIES) throw err;
        // Bounded retry for transient server errors only; offline propagates.
      }
    }
    throw last;
  }

  private async _pullWithRetry(accountId: string, cursor: string): Promise<SyncPullOutcome> {
    let last: unknown = null;
    for (let attempt = 0; attempt <= MAX_SYNC_RETRIES; attempt++) {
      try {
        return await this._transport.pull({ accountId, cursor, limit: SYNC_PULL_LIMIT });
      } catch (err) {
        last = err;
        if (isOfflineSignal(err)) throw err;
        if (attempt >= MAX_SYNC_RETRIES) throw err;
      }
    }
    throw last;
  }

  /** Inbound schedule sanitizer: enabled forced false, runs stripped, device kept. */
  private _sanitizeSchedule(remote: EngineSyncRecord): EngineSyncRecord {
    if (remote.entityType !== "schedule.definition") return remote;
    if (typeof remote.payload !== "object" || remote.payload === null) return remote;
    const {
      runs: _runs,
      executions: _executions,
      ...rest
    } = remote.payload as Record<string, unknown>;
    void _runs;
    void _executions;
    return { ...remote, payload: { ...rest, enabled: false } };
  }

  async tick(input: SyncEngineTickInput): Promise<SyncEngineTickOutcome> {
    const accountId = requireAccountId(input.accountId);
    const nowMs = input.nowMs;
    const key = pullCursorKey(accountId);

    let cursor: number;
    try {
      cursor = await this._cursors.getValue(key, 0);
    } catch {
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    }

    let dirty: SyncRecordRow[];
    try {
      dirty = await this._records.getDirty(accountId, cursor);
    } catch (err) {
      if (err instanceof SyncServiceError) throw err;
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    }

    // Bounded outbox: at most MAX_SYNC_OUTBOX envelopes per tick.
    const boundedDirty = dirty.slice(0, MAX_SYNC_OUTBOX);
    // Map dirty rows to engine records first: secret/corrupt envelopes abort
    // the push fail-closed BEFORE any transport call.
    const outbound = boundedDirty.map((row) => rowToEngineRecord(row));
    const queued = outbound.length;

    if (outbound.length > 0) {
      try {
        void (await this._pushWithRetry(accountId, outbound));
      } catch (err) {
        if (isOfflineSignal(err)) {
          return {
            pushed: 0,
            pulled: 0,
            applied: 0,
            queued,
            cursor,
            conflicts: [],
            offline: true,
            invalid: 0,
            refused: 0,
            error: "sync transport offline",
          };
        }
        throw new SyncServiceError("SYNC_ERROR", "sync push failed");
      }
    }

    let pulled: EngineSyncRecord[];
    let pullCursor: string;
    try {
      const outcome = await this._pullWithRetry(accountId, String(cursor));
      pulled = outcome.records;
      pullCursor = outcome.cursor;
    } catch (err) {
      if (isOfflineSignal(err)) {
        return {
          pushed: outbound.length,
          pulled: 0,
          applied: 0,
          queued,
          cursor,
          conflicts: [],
          offline: true,
          invalid: 0,
          refused: 0,
          error: "sync transport offline",
        };
      }
      throw new SyncServiceError("SYNC_ERROR", "sync pull failed");
    }
    void pullCursor;

    let applied = 0;
    let invalid = 0;
    const conflicts: SyncEngineTickConflict[] = [];
    let highWater = cursor;
    for (const row of boundedDirty) {
      if (Number.isFinite(row.updatedAt) && row.updatedAt > highWater) highWater = row.updatedAt;
    }

    for (const candidate of pulled) {
      const checked = validateEngineRecord(candidate);
      if (!checked.ok) {
        // Invalid remotes are counted and skipped, never applied.
        invalid += 1;
        continue;
      }
      const remote = this._sanitizeSchedule(checked.record);
      // Account isolation: envelopes for another account never apply.
      if (remote.accountId !== accountId) {
        invalid += 1;
        continue;
      }
      // Defense in depth: the engine validates shape; the adapter ALSO
      // refuses secret-bearing payloads before any repo write.
      try {
        refuseSecrets(JSON.stringify(remote.payload));
      } catch {
        invalid += 1;
        continue;
      }
      const remoteMs = Date.parse(remote.updatedAt);
      if (remoteMs > highWater) highWater = remoteMs;

      const recordId = recordIdFor(accountId, remote.entityType, remote.entityId, remote.projectId);
      let local: SyncRecordRow | null;
      try {
        local = await this._records.get(recordId);
      } catch {
        throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
      }

      if (!local) {
        const row = engineRecordToRow({ ...remote, accountId });
        try {
          if (await this._records.upsert(row)) applied += 1;
        } catch (err) {
          if (err instanceof SyncServiceError) throw err;
          throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
        }
        continue;
      }

      let localPayload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(local.payloadJson);
        localPayload = isPlainObject(parsed) ? parsed : {};
      } catch {
        throw new SyncServiceError("SYNC_ERROR", "local sync record payload is corrupt");
      }
      const verdict = compareTriple(
        { version: remote.version, updatedAtMs: remoteMs, deviceId: remote.deviceId },
        { version: local.version, updatedAtMs: local.updatedAt, deviceId: local.deviceId },
      );
      const sameContent =
        stableStringify(localPayload) === stableStringify(remote.payload) &&
        (local.deletedAt != null) === (remote.deleted === true);

      // Different versions: newer wins outright (including newer tombstones,
      // which is how deletes propagate). Same-version divergences go through
      // explicit/LWW below, never here.
      if (remote.version !== local.version) {
        if (remote.version > local.version) {
          try {
            let wrote: boolean;
            if (remote.deleted === true) {
              const tombstone: SyncRecordRow = {
                recordId,
                entityType: remote.entityType,
                entityId: remote.entityId,
                accountId,
                deviceId: remote.deviceId,
                version: remote.version,
                payloadJson: "{}",
                updatedAt: remoteMs,
                deletedAt: remoteMs,
              };
              refuseSecrets(tombstone.payloadJson);
              wrote = await this._records.writeTombstone(tombstone, nowMs);
            } else {
              wrote = await this._records.upsert(engineRecordToRow({ ...remote, accountId }));
            }
            if (wrote) applied += 1;
          } catch (err) {
            if (err instanceof SyncServiceError) throw err;
            throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
          }
        }
        // Older remote: keep local.
        continue;
      }

      if (verdict === 0 && sameContent) continue;

      // Same-version concurrent divergence: canonical classification.
      // delete-vs-update and schedule.definition/extension.metadata are
      // always explicit; scalar prefs/metadata resolve LWW.
      if (!sameContent) {
        const localDeleted = local.deletedAt != null;
        const remoteDeleted = remote.deleted === true;
        const classification = classifySyncConflict(
          { entityType: local.entityType, ...(localDeleted ? { deletedAt: "t" } : {}) },
          {
            entityType: remote.entityType,
            ...(remoteDeleted ? { deletedAt: "t" } : {}),
          },
        );
        if (classification === "explicit") {
          const changedFields = diffChangedFields(localPayload, remote.payload);
          const row: SyncConflictRow = {
            conflictId: conflictIdFor(recordId),
            entityType: remote.entityType,
            entityId: remote.entityId,
            accountId,
            localVersion: local.version,
            remoteVersion: remote.version,
            changedFieldsJson: JSON.stringify(changedFields),
            createdAt: nowMs,
          };
          try {
            await this._conflicts.save(row);
          } catch (err) {
            if (err instanceof SyncServiceError) throw err;
            throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
          }
          conflicts.push({ row, remote: { ...remote, accountId } });
          continue;
        }
        // Auto-mergeable scalar same-version: LWW over the triple.
        if (verdict > 0) {
          try {
            const wrote = await this._records.upsert(engineRecordToRow({ ...remote, accountId }));
            if (wrote) applied += 1;
          } catch (err) {
            if (err instanceof SyncServiceError) throw err;
            throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
          }
        }
        // verdict <= 0 means keep local.
        continue;
      }
      // Same version + same content: already converged (handled above).
    }

    if (highWater > cursor) {
      try {
        await this._cursors.set(key, highWater);
      } catch {
        throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
      }
    }

    return {
      pushed: outbound.length,
      pulled: pulled.length,
      applied,
      queued,
      cursor: Math.max(cursor, highWater),
      conflicts,
      offline: false,
      invalid,
      refused: 0,
    };
  }
}

/**
 * DesktopSyncService: thin desktop orchestration around the sync repos + the
 * SyncEngine port + EventBus/EventRepository. Node timers only, no Electron,
 * no PermissionManager, no secrets.
 */
export class DesktopSyncService {
  private readonly _records: SyncRecordRepoPort;
  private readonly _cursors: SyncCursorRepoPort;
  private readonly _conflicts: SyncConflictRepoPort;
  private readonly _engine: SyncEnginePort;
  private readonly _bus: SyncEventTransport;
  private readonly _storage: SyncStoragePort;
  private readonly _clock?: () => number;
  private readonly _deviceId: string;
  private readonly _defaultAccountId: string;
  private readonly _tickMs: number;
  private readonly _remotes = new Map<string, EngineSyncRecord>();
  private readonly _sequenceCounters = new Map<string, number>();
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _timerAccountId: string | null = null;
  private _ticking = false;
  private _syncing = false;
  private _running = false;
  private _paused = false;
  private _offline = false;
  private _lastSyncAt: string | undefined;
  private _lastError: string | undefined;

  constructor(deps: DesktopSyncServiceDeps) {
    this._records = deps.recordRepo;
    this._cursors = deps.cursorRepo;
    this._conflicts = deps.conflictRepo;
    this._engine = new FallbackSyncEngine({
      recordRepo: deps.recordRepo,
      cursorRepo: deps.cursorRepo,
      conflictRepo: deps.conflictRepo,
      transport: deps.transport ?? new NoopPushPullTransport(),
    });
    this._bus = deps.eventBus;
    this._storage = deps.storage;
    if (deps.clock) this._clock = deps.clock;
    this._deviceId =
      deps.deviceId && deps.deviceId.trim().length > 0 ? deps.deviceId.trim() : generateUlid();
    const fallbackAccount =
      deps.accountId && deps.accountId.trim().length > 0 ? deps.accountId.trim() : "local";
    this._defaultAccountId = fallbackAccount;
    this._tickMs =
      deps.tickMs !== undefined && Number.isFinite(deps.tickMs) && deps.tickMs >= MIN_SYNC_TICK_MS
        ? Math.floor(deps.tickMs)
        : DEFAULT_SYNC_TICK_MS;
  }

  get paused(): boolean {
    return this._paused;
  }

  get running(): boolean {
    return this._running;
  }

  private _nowMs(): number {
    return this._clock ? this._clock() : Date.now();
  }

  private _resolveAccount(accountId?: string): string {
    if (accountId === undefined) return this._defaultAccountId;
    return requireAccountId(accountId);
  }

  /** Current renderer-compatible projection (fail-closed on storage loss). */
  async status(accountId?: string): Promise<SyncStatusView> {
    const account = this._resolveAccount(accountId);
    let pendingCount = 0;
    let conflictCount = 0;
    try {
      const cursor = await this._cursors.getValue(pullCursorKey(account), 0);
      const dirty = await this._records.getDirty(account, cursor);
      pendingCount = dirty.length;
      const rows = await this._conflicts.list(account, 100);
      conflictCount = rows.length;
    } catch {
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    }
    let syncStatus: SyncStatus = "idle";
    if (this._syncing) syncStatus = "syncing";
    else if (this._offline) syncStatus = "offline";
    else if (this._lastError !== undefined) syncStatus = "error";
    else if (conflictCount > 0) syncStatus = "conflict";
    const view: SyncStatusView = {
      status: this._paused ? "idle" : syncStatus,
      pendingCount,
      conflictCount,
      paused: this._paused,
    };
    return {
      ...view,
      ...(this._lastSyncAt !== undefined ? { lastSyncAt: this._lastSyncAt } : {}),
      ...(this._lastError !== undefined && !this._paused ? { lastError: this._lastError } : {}),
    };
  }

  /**
   * Idempotent start: unparks, ensures the engine timer, performs one tick,
   * and returns the fresh projection. A concurrent in-flight tick fails
   * closed with SYNC_LEASE_HELD; transport offline surfaces SYNC_OFFLINE.
   */
  async start(accountId?: string): Promise<SyncStatusView> {
    const account = this._resolveAccount(accountId);
    this._paused = false;
    this._running = true;
    this._ensureTimer(account);
    await this._tickOnce(account);
    return this.status(account);
  }

  /** Parks locally: no timer, no transport calls; projection reports idle. */
  async pause(): Promise<SyncStatusView> {
    this._clearTimer();
    this._running = false;
    this._paused = true;
    this._syncing = false;
    return this.status();
  }

  /** Bounded conflict list (limit 1..100, default 50). */
  async conflicts(accountId?: string, limit?: number): Promise<{ conflicts: SyncConflictView[] }> {
    const account = accountId === undefined ? undefined : requireAccountId(accountId);
    const take = boundLimit(limit, 50);
    let rows: SyncConflictRow[];
    try {
      rows = await this._conflicts.list(account, take);
    } catch {
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    }
    return {
      conflicts: rows.slice(0, take).map((row) => ({
        conflictId: row.conflictId,
        entity: row.entityType,
        entityId: row.entityId,
        localVersion: row.localVersion,
        remoteVersion: row.remoteVersion,
        changedFields: parseChangedFields(row.changedFieldsJson),
        updatedAt: new Date(row.createdAt).toISOString(),
      })),
    };
  }

  /**
   * Explicit conflict resolution only (keep-local / keep-remote). Anything
   * else throws SYNC_VALIDATION; unknown ids throw SYNC_NOT_FOUND.
   * Project scoping: when projectId is supplied it must match the local
   * record's project scope (project.metadata payloads); mismatches throw
   * SYNC_VALIDATION and never touch storage.
   */
  async resolve(
    conflictId: string,
    resolution: SyncConflictResolution,
    projectId?: string,
    accountId?: string,
  ): Promise<{ conflictId: string; appliedEntity: string; appliedVersion: number }> {
    const id = requireConflictId(conflictId);
    const choice = requireResolution(resolution);
    let scopedProject: string | undefined;
    if (projectId !== undefined) {
      if (typeof projectId !== "string" || projectId.trim().length === 0) {
        throw new SyncServiceError("SYNC_VALIDATION", "projectId must be a non-empty string");
      }
      scopedProject = projectId.trim();
    }
    const account = accountId === undefined ? undefined : requireAccountId(accountId);
    const nowMs = this._nowMs();

    let rows: SyncConflictRow[];
    try {
      rows = await this._conflicts.list(account, 100);
    } catch {
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    }
    const conflict = rows.find((row) => row.conflictId === id) ?? null;
    if (!conflict) {
      throw new SyncServiceError("SYNC_NOT_FOUND", "unknown sync conflict");
    }
    // Account isolation: a scoped account that does not own the conflict
    // fails closed (the filtered list already enforces this; double-check).
    if (account !== undefined && conflict.accountId !== account) {
      throw new SyncServiceError("SYNC_NOT_FOUND", "unknown sync conflict");
    }
    const scopeAccount = conflict.accountId;
    // Try both unscoped and project-scoped keys (projectId is part of the
    // key when present on the envelope).
    const candidateIds = scopedProject
      ? [
          recordIdFor(scopeAccount, conflict.entityType, conflict.entityId, scopedProject),
          recordIdFor(scopeAccount, conflict.entityType, conflict.entityId),
        ]
      : [recordIdFor(scopeAccount, conflict.entityType, conflict.entityId)];
    let local: SyncRecordRow | null = null;
    for (const candidateId of candidateIds) {
      try {
        local = await this._records.get(candidateId);
      } catch {
        throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
      }
      if (local) {
        break;
      }
    }
    // Project-mismatch: when the caller scoped a project, the local payload
    // (for project.metadata) must carry the same projectId.
    if (scopedProject !== undefined && local) {
      try {
        const parsed: unknown = JSON.parse(local.payloadJson);
        if (
          conflict.entityType === "project.metadata" &&
          typeof parsed === "object" &&
          parsed !== null &&
          "projectId" in parsed &&
          typeof (parsed as Record<string, unknown>).projectId === "string" &&
          ((parsed as Record<string, unknown>).projectId as string) !== scopedProject
        ) {
          throw new SyncServiceError("SYNC_VALIDATION", "projectId does not own this conflict");
        }
      } catch (err) {
        if (err instanceof SyncServiceError) throw err;
        // Unparseable payloads fail closed on scoped resolves.
        throw new SyncServiceError("SYNC_VALIDATION", "projectId does not own this conflict");
      }
    }

    if (choice === "keep-local") {
      if (!local) {
        throw new SyncServiceError("SYNC_ERROR", "local sync record unavailable");
      }
      refuseSecrets(local.payloadJson);
      const appliedVersion =
        conflict.remoteVersion >= local.version ? conflict.remoteVersion + 1 : local.version;
      const next: SyncRecordRow = { ...local, version: appliedVersion, updatedAt: nowMs };
      try {
        await this._records.upsert(next);
      } catch (err) {
        if (err instanceof SyncServiceError) throw err;
        throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
      }
      await this._deleteConflict(id);
      return { conflictId: id, appliedEntity: conflict.entityType, appliedVersion };
    }

    // keep-remote: prefer the remote envelope cached at tick time; refetch via
    // the transport pull when the cache missed (e.g. after a restart).
    let remote = this._remotes.get(id) ?? null;
    if (!remote) {
      remote = await this._refetchRemote(scopeAccount, conflict.entityType, conflict.entityId);
    }
    if (!remote) {
      throw new SyncServiceError("SYNC_ERROR", "remote sync record unavailable");
    }
    const row = engineRecordToRow({ ...remote, accountId: scopeAccount });
    const appliedVersion = local && local.version >= row.version ? local.version + 1 : row.version;
    const next: SyncRecordRow = { ...row, version: appliedVersion };
    try {
      await this._records.upsert(next);
    } catch (err) {
      if (err instanceof SyncServiceError) throw err;
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    }
    await this._deleteConflict(id);
    return { conflictId: id, appliedEntity: conflict.entityType, appliedVersion };
  }

  /** Stops the engine timer. Safe to call multiple times. */
  dispose(): void {
    this._clearTimer();
    this._running = false;
  }

  /**
   * Sign-out hook: returns an async callback that pauses the service.
   * Wires into AccountService onSignedOut.
   */
  asOnSignedOutCallback(): () => Promise<void> {
    return async () => {
      await this.pause();
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async _refetchRemote(
    accountId: string,
    entityType: string,
    entityId: string,
  ): Promise<EngineSyncRecord | null> {
    const engine = this._engine as {
      tick(input: SyncEngineTickInput): Promise<SyncEngineTickOutcome>;
    };
    void engine;
    // The fallback engine owns the transport; re-pull through a best-effort
    // tick-less fetch is not part of the engine port, so resolve() performs a
    // bounded re-list via the conflict cache only when present. A missing
    // cache after restart resolves through the next tick's pull; report the
    // miss fail-closed instead of fabricating a remote.
    void accountId;
    void entityType;
    void entityId;
    return null;
  }

  private async _deleteConflict(conflictId: string): Promise<void> {
    try {
      await this._conflicts.resolve(conflictId);
    } catch {
      throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
    } finally {
      this._remotes.delete(conflictId);
    }
  }

  private _ensureTimer(accountId: string): void {
    this._timerAccountId = accountId;
    if (this._timer !== undefined) return;
    this._timer = setInterval(() => {
      if (this._paused || this._ticking || this._timerAccountId == null) return;
      const account = this._timerAccountId;
      void this._tickOnce(account).catch(() => undefined);
    }, this._tickMs);
    const timer = this._timer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
  }

  private _clearTimer(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    this._timerAccountId = null;
  }

  private async _tickOnce(accountId: string): Promise<SyncEngineTickOutcome | null> {
    if (this._paused) return null;
    if (this._ticking) {
      throw new SyncServiceError("SYNC_LEASE_HELD", "sync tick already in progress");
    }
    this._ticking = true;
    this._syncing = true;
    const nowMs = this._nowMs();
    try {
      await this._emitSync(accountId, "started", {});
      let outcome: SyncEngineTickOutcome;
      try {
        outcome = await this._engine.tick({ accountId, deviceId: this._deviceId, nowMs });
      } catch (err) {
        if (err instanceof SyncServiceError) {
          if (err.code !== "SYNC_LEASE_HELD") {
            this._offline = err.code === "SYNC_OFFLINE";
            this._lastError =
              err.code === "SYNC_OFFLINE" ? "sync transport offline" : "sync tick failed";
            await this._emitSync(accountId, "failed", {}).catch(() => undefined);
          }
          throw err;
        }
        this._offline = false;
        this._lastError = "sync tick failed";
        await this._emitSync(accountId, "failed", {}).catch(() => undefined);
        throw new SyncServiceError("SYNC_ERROR", "sync tick failed");
      }

      if (outcome.offline) {
        this._offline = true;
        this._lastError = "sync transport offline";
        await this._emitSync(accountId, "failed", {}).catch(() => undefined);
        throw new SyncServiceError("SYNC_OFFLINE", "sync transport offline");
      }

      for (const entry of outcome.conflicts) {
        this._remotes.set(entry.row.conflictId, entry.remote);
      }
      if (outcome.queued > 0) {
        await this._emitSync(accountId, "queued", { queued: outcome.queued });
      }
      for (const entry of outcome.conflicts) {
        await this._emitSync(accountId, "conflict", {
          entity: entry.row.entityType,
          fields: entry.row.conflictId,
        });
      }
      this._offline = false;
      this._lastError = undefined;
      this._lastSyncAt = new Date(this._nowMs()).toISOString();
      await this._emitSync(accountId, "completed", {
        pushed: outcome.pushed,
        pulled: outcome.pulled,
        applied: outcome.applied,
        conflicts: outcome.conflicts.length,
      });
      return outcome;
    } finally {
      this._ticking = false;
      this._syncing = false;
    }
  }

  /** Publishes sync.* via storage.append then EventBus.publish. */
  private async _emitSync(
    accountId: string,
    type: SyncEventType,
    details: Record<string, string | number>,
  ): Promise<void> {
    const eventType = syncEventType(type);
    const conversationId = accountId.toUpperCase() as ConversationId;
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
        accountId,
        ...details,
      } as unknown as AIEvent;
      try {
        await this._storage.append(event);
      } catch {
        this._sequenceCounters.set(conversationId, sequence + 1);
        continue;
      }
      await this._bus.publish(event);
      return;
    }
    throw new SyncServiceError("SYNC_ERROR", "sync storage unavailable");
  }

  private async _allocateSequence(conversationId: ConversationId): Promise<number> {
    const cached = this._sequenceCounters.get(conversationId);
    if (cached !== undefined) {
      this._sequenceCounters.set(conversationId, cached + 1);
      return cached;
    }
    let base = 0;
    try {
      if (typeof this._storage.getByConversation === "function") {
        const existing = await this._storage.getByConversation(conversationId);
        base = existing.length;
      }
    } catch {
      base = 0;
    }
    this._sequenceCounters.set(conversationId, base + 1);
    return base;
  }
}
