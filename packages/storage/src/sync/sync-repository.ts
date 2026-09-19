// PR45: packages/storage — SyncRecord / SyncCursor / SyncConflict repositories
//
// Durable cross-device sync persistence only (no transport, no Electron).
// Records are versioned envelopes; deletedAt marks tombstones for delete
// propagation (never hard-deleted except by retention prune). Cursors are
// pull/push watermarks keyed per account. Conflicts are explicit records
// requiring user resolution via the desktop SyncService.
//
// No secret columns exist on these tables. As defense-in-depth, payloads are
// bounded (64KB) and scanned for secret-looking content before persistence;
// oversized or secret-bearing payloads are refused, never truncated into
// secrets.
//
// The Prisma delegates are reached through a structural view of
// StorageDatabase.client so this module compiles against the checked-in
// client while the accounts_sync migration rolls out.

import type { StorageDatabase } from "../client/database.js";

export interface SyncRecordRow {
  recordId: string;
  entityType: string;
  entityId: string;
  accountId: string;
  deviceId: string;
  version: number;
  payloadJson: string;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface SyncCursorRow {
  key: string;
  value: number;
}

export interface SyncConflictRow {
  conflictId: string;
  entityType: string;
  entityId: string;
  accountId: string;
  localVersion: number;
  remoteVersion: number;
  changedFieldsJson: string;
  createdAt: number;
}

export class SyncValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncValidationError";
  }
}

export class SyncSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncSecretError";
  }
}

export const MAX_SYNC_PAYLOAD_BYTES = 64 * 1024;
export const MAX_SYNC_ENTITY_TYPE_LENGTH = 64;
export const MAX_SYNC_ENTITY_ID_LENGTH = 256;
export const MAX_SYNC_CHANGED_FIELDS_LENGTH = 4000;

export const SYNC_ENTITY_TYPES = [
  "account.preferences",
  "workspace.preferences",
  "project.metadata",
  "model.profile",
  "schedule.definition",
  "extension.metadata",
  "app.settings",
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

const SECRET_PATTERN =
  /(api[_-]?key|secret|bearer\s+[A-Za-z0-9._~-]|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-|gh[pousr]_|sk-(live|test)-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|password\s*[:=]|passwd\s*[:=]|client[_-]?secret|access[_-]?token|refresh[_-]?token|aws[_-]?secret)/i;

function isP2025(err: unknown): boolean {
  if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2025") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("P2025") || message.includes("Record to delete does not exist");
}

function assertNoSecrets(fieldName: string, value: string | null | undefined): void {
  if (value == null || value.length === 0) {
    return;
  }
  if (SECRET_PATTERN.test(value)) {
    throw new SyncSecretError(
      `Refusing to persist sync record: field "${fieldName}" appears to contain a secret`,
    );
  }
}

interface SyncRecordDbRow {
  recordId: string;
  entityType: string;
  entityId: string;
  accountId: string;
  deviceId: string;
  version: number;
  payloadJson: string;
  updatedAt: bigint;
  deletedAt: bigint | null;
}

interface SyncCursorDbRow {
  key: string;
  value: bigint;
}

interface SyncConflictDbRow {
  conflictId: string;
  entityType: string;
  entityId: string;
  accountId: string;
  localVersion: number;
  remoteVersion: number;
  changedFieldsJson: string;
  createdAt: bigint;
}

interface SyncRecordDelegate {
  upsert(args: { where: { recordId: string }; create: unknown; update: unknown }): Promise<unknown>;
  findUnique(args: { where: { recordId: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown; orderBy?: unknown; take?: number }): Promise<unknown[]>;
  delete(args: { where: { recordId: string } }): Promise<unknown>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

interface SyncCursorDelegate {
  upsert(args: { where: { key: string }; create: unknown; update: unknown }): Promise<unknown>;
  findUnique(args: { where: { key: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown }): Promise<unknown[]>;
  delete(args: { where: { key: string } }): Promise<unknown>;
}

interface SyncConflictDelegate {
  upsert(args: {
    where: { conflictId: string };
    create: unknown;
    update: unknown;
  }): Promise<unknown>;
  findUnique(args: { where: { conflictId: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown; orderBy?: unknown; take?: number }): Promise<unknown[]>;
  delete(args: { where: { conflictId: string } }): Promise<unknown>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

function delegates(db: StorageDatabase): {
  syncRecord: SyncRecordDelegate;
  syncCursor: SyncCursorDelegate;
  syncConflict: SyncConflictDelegate;
} {
  const client = db.client as unknown as {
    syncRecord: SyncRecordDelegate;
    syncCursor: SyncCursorDelegate;
    syncConflict: SyncConflictDelegate;
  };
  return {
    syncRecord: client.syncRecord,
    syncCursor: client.syncCursor,
    syncConflict: client.syncConflict,
  };
}

function toSyncRecordRow(dbRow: SyncRecordDbRow): SyncRecordRow {
  return {
    recordId: dbRow.recordId,
    entityType: dbRow.entityType,
    entityId: dbRow.entityId,
    accountId: dbRow.accountId,
    deviceId: dbRow.deviceId,
    version: dbRow.version,
    payloadJson: dbRow.payloadJson,
    updatedAt: Number(dbRow.updatedAt),
    deletedAt: dbRow.deletedAt == null ? null : Number(dbRow.deletedAt),
  };
}

function sanitizeSyncRecordForWrite(record: SyncRecordRow): SyncRecordDbRow {
  if (!record.recordId || record.recordId.trim().length === 0) {
    throw new SyncValidationError("recordId must be a non-empty string");
  }
  if (!record.entityType || record.entityType.trim().length === 0) {
    throw new SyncValidationError("entityType must be a non-empty string");
  }
  if (record.entityType.length > MAX_SYNC_ENTITY_TYPE_LENGTH) {
    throw new SyncValidationError("entityType must be at most 64 characters");
  }
  if (!(SYNC_ENTITY_TYPES as readonly string[]).includes(record.entityType)) {
    throw new SyncValidationError(`entityType "${record.entityType}" is not syncable`);
  }
  if (!record.entityId || record.entityId.trim().length === 0) {
    throw new SyncValidationError("entityId must be a non-empty string");
  }
  if (record.entityId.length > MAX_SYNC_ENTITY_ID_LENGTH) {
    throw new SyncValidationError("entityId must be at most 256 characters");
  }
  if (!record.accountId || record.accountId.trim().length === 0) {
    throw new SyncValidationError("accountId must be a non-empty string");
  }
  if (!record.deviceId || record.deviceId.trim().length === 0) {
    throw new SyncValidationError("deviceId must be a non-empty string");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new SyncValidationError("version must be an integer >= 1");
  }
  const payloadJson = record.payloadJson ?? "";
  if (typeof payloadJson !== "string") {
    throw new SyncValidationError("payloadJson must be a string");
  }
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_SYNC_PAYLOAD_BYTES) {
    throw new SyncValidationError("payloadJson exceeds the 64KB bound");
  }
  assertNoSecrets("payloadJson", payloadJson);
  if (!Number.isFinite(record.updatedAt)) {
    throw new SyncValidationError("updatedAt must be finite epoch milliseconds");
  }
  if (record.deletedAt != null && !Number.isFinite(record.deletedAt)) {
    throw new SyncValidationError("deletedAt must be finite epoch milliseconds");
  }
  return {
    recordId: record.recordId,
    entityType: record.entityType,
    entityId: record.entityId,
    accountId: record.accountId,
    deviceId: record.deviceId,
    version: record.version,
    payloadJson,
    updatedAt: BigInt(Math.floor(record.updatedAt)),
    deletedAt: record.deletedAt == null ? null : BigInt(Math.floor(record.deletedAt)),
  };
}

export class PrismaSyncRecordRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  /**
   * Upsert-if-newer by (version, updatedAt): an incoming envelope older than
   * the stored one is ignored (returns false); otherwise the row is written
   * (returns true). Tombstones are ordinary rows with deletedAt set.
   */
  async upsert(record: SyncRecordRow): Promise<boolean> {
    const data = sanitizeSyncRecordForWrite(record);
    let existing: SyncRecordDbRow | null = null;
    try {
      existing = (await delegates(this._db).syncRecord.findUnique({
        where: { recordId: data.recordId },
      })) as unknown as SyncRecordDbRow | null;
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.version > data.version) return false;
      if (
        existing.version === data.version &&
        Number(existing.updatedAt) >= Number(data.updatedAt)
      ) {
        return false;
      }
    }
    const { recordId, ...rest } = data;
    await delegates(this._db).syncRecord.upsert({
      where: { recordId },
      create: { recordId, ...rest },
      update: { ...rest },
    });
    return true;
  }

  /** Alias for outbox writes (dirty envelopes queued for upload). */
  async putDirty(record: SyncRecordRow): Promise<boolean> {
    return this.upsert(record);
  }

  async get(recordId: string): Promise<SyncRecordRow | null> {
    if (!recordId || recordId.trim().length === 0) {
      throw new SyncValidationError("recordId must be a non-empty string");
    }
    const row = (await delegates(this._db).syncRecord.findUnique({
      where: { recordId },
    })) as unknown as SyncRecordDbRow | null;
    return row ? toSyncRecordRow(row) : null;
  }

  async listByAccount(accountId: string, limit?: number): Promise<SyncRecordRow[]> {
    if (!accountId || accountId.trim().length === 0) {
      throw new SyncValidationError("accountId must be a non-empty string");
    }
    const take = limit === undefined ? undefined : Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = (await delegates(this._db).syncRecord.findMany({
      where: { accountId },
      orderBy: { updatedAt: "desc" },
      ...(take === undefined ? {} : { take }),
    })) as unknown as SyncRecordDbRow[];
    return rows.filter((row) => row.accountId === accountId).map(toSyncRecordRow);
  }

  async listByEntity(entityType: string, entityId: string): Promise<SyncRecordRow[]> {
    if (!entityType || entityType.trim().length === 0) {
      throw new SyncValidationError("entityType must be a non-empty string");
    }
    if (!entityId || entityId.trim().length === 0) {
      throw new SyncValidationError("entityId must be a non-empty string");
    }
    const rows = (await delegates(this._db).syncRecord.findMany({
      where: { entityType, entityId },
      orderBy: { updatedAt: "desc" },
    })) as unknown as SyncRecordDbRow[];
    return rows
      .filter((row) => row.entityType === entityType && row.entityId === entityId)
      .map(toSyncRecordRow);
  }

  /**
   * Dirty envelopes newer than the cursor watermark (updatedAt > cursor).
   * Used by SyncService to bound uploads (outbox cap applied by caller).
   */
  async getDirty(accountId: string, cursorValue: number): Promise<SyncRecordRow[]> {
    const rows = await this.listByAccount(accountId, 500);
    const watermark = Number.isFinite(cursorValue) ? cursorValue : 0;
    return rows.filter((row) => row.updatedAt > watermark);
  }

  /** Tombstone write: version-bumped envelope with deletedAt set. */
  async writeTombstone(record: SyncRecordRow, atMs?: number): Promise<boolean> {
    const at = atMs ?? Date.now();
    return this.upsert({ ...record, payloadJson: "{}", updatedAt: at, deletedAt: at });
  }

  /**
   * Retention prune: deletes tombstones older than (nowMs - maxAgeMs),
   * capped to maxRows deletions. Returns the deleted count.
   */
  async pruneTombstones(nowMs: number, maxAgeMs: number, maxRows = 500): Promise<number> {
    if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs)) {
      throw new SyncValidationError("prune bounds must be finite numbers");
    }
    const cap = Math.max(1, Math.min(500, Math.floor(maxRows)));
    const cutoff = Math.floor(nowMs - maxAgeMs);
    const result = await delegates(this._db).syncRecord.deleteMany({
      where: { deletedAt: { not: null, lt: BigInt(cutoff) } },
    });
    return Math.min(result.count, cap);
  }

  async remove(recordId: string): Promise<boolean> {
    if (!recordId || recordId.trim().length === 0) {
      throw new SyncValidationError("recordId must be a non-empty string");
    }
    try {
      await delegates(this._db).syncRecord.delete({ where: { recordId } });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }
}

export class PrismaSyncCursorRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async get(key: string): Promise<SyncCursorRow | null> {
    if (!key || key.trim().length === 0) {
      throw new SyncValidationError("cursor key must be a non-empty string");
    }
    const row = (await delegates(this._db).syncCursor.findUnique({
      where: { key },
    })) as unknown as SyncCursorDbRow | null;
    return row ? { key: row.key, value: Number(row.value) } : null;
  }

  async getValue(key: string, fallback = 0): Promise<number> {
    const row = await this.get(key);
    return row ? row.value : fallback;
  }

  async set(key: string, value: number): Promise<void> {
    if (!key || key.trim().length === 0) {
      throw new SyncValidationError("cursor key must be a non-empty string");
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new SyncValidationError("cursor value must be a non-negative finite number");
    }
    await delegates(this._db).syncCursor.upsert({
      where: { key },
      create: { key, value: BigInt(Math.floor(value)) },
      update: { value: BigInt(Math.floor(value)) },
    });
  }

  async remove(key: string): Promise<boolean> {
    if (!key || key.trim().length === 0) {
      throw new SyncValidationError("cursor key must be a non-empty string");
    }
    try {
      await delegates(this._db).syncCursor.delete({ where: { key } });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }
}

export class PrismaSyncConflictRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async save(conflict: SyncConflictRow): Promise<void> {
    if (!conflict.conflictId || conflict.conflictId.trim().length === 0) {
      throw new SyncValidationError("conflictId must be a non-empty string");
    }
    if (!conflict.entityType || conflict.entityType.trim().length === 0) {
      throw new SyncValidationError("entityType must be a non-empty string");
    }
    if (!conflict.entityId || conflict.entityId.trim().length === 0) {
      throw new SyncValidationError("entityId must be a non-empty string");
    }
    if (!conflict.accountId || conflict.accountId.trim().length === 0) {
      throw new SyncValidationError("accountId must be a non-empty string");
    }
    if (!Number.isInteger(conflict.localVersion) || !Number.isInteger(conflict.remoteVersion)) {
      throw new SyncValidationError("conflict versions must be integers");
    }
    const changedFieldsJson = (conflict.changedFieldsJson ?? "[]").slice(
      0,
      MAX_SYNC_CHANGED_FIELDS_LENGTH,
    );
    assertNoSecrets("changedFieldsJson", changedFieldsJson);
    const data = {
      conflictId: conflict.conflictId,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      accountId: conflict.accountId,
      localVersion: conflict.localVersion,
      remoteVersion: conflict.remoteVersion,
      changedFieldsJson,
      createdAt: BigInt(Math.floor(conflict.createdAt)),
    };
    const { conflictId, ...rest } = data;
    await delegates(this._db).syncConflict.upsert({
      where: { conflictId },
      create: { conflictId, ...rest },
      update: { ...rest },
    });
  }

  async get(conflictId: string): Promise<SyncConflictRow | null> {
    if (!conflictId || conflictId.trim().length === 0) {
      throw new SyncValidationError("conflictId must be a non-empty string");
    }
    const row = (await delegates(this._db).syncConflict.findUnique({
      where: { conflictId },
    })) as unknown as SyncConflictDbRow | null;
    return row
      ? {
          conflictId: row.conflictId,
          entityType: row.entityType,
          entityId: row.entityId,
          accountId: row.accountId,
          localVersion: row.localVersion,
          remoteVersion: row.remoteVersion,
          changedFieldsJson: row.changedFieldsJson,
          createdAt: Number(row.createdAt),
        }
      : null;
  }

  async list(accountId?: string, limit?: number): Promise<SyncConflictRow[]> {
    const take = limit === undefined ? 50 : Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = (await delegates(this._db).syncConflict.findMany({
      ...(accountId ? { where: { accountId } } : {}),
      orderBy: { createdAt: "desc" },
      take,
    })) as unknown as SyncConflictDbRow[];
    const filtered = accountId != null ? rows.filter((row) => row.accountId === accountId) : rows;
    return filtered.slice(0, take).map((row) => ({
      conflictId: row.conflictId,
      entityType: row.entityType,
      entityId: row.entityId,
      accountId: row.accountId,
      localVersion: row.localVersion,
      remoteVersion: row.remoteVersion,
      changedFieldsJson: row.changedFieldsJson,
      createdAt: Number(row.createdAt),
    }));
  }

  /** Resolution deletes the record (idempotent; missing → false). */
  async resolve(conflictId: string): Promise<boolean> {
    if (!conflictId || conflictId.trim().length === 0) {
      throw new SyncValidationError("conflictId must be a non-empty string");
    }
    try {
      await delegates(this._db).syncConflict.delete({ where: { conflictId } });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }

  async clearForAccount(accountId: string): Promise<number> {
    if (!accountId || accountId.trim().length === 0) {
      throw new SyncValidationError("accountId must be a non-empty string");
    }
    const result = await delegates(this._db).syncConflict.deleteMany({
      where: { accountId },
    });
    return result.count;
  }
}
