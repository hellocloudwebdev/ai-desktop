// PR45: packages/storage — PrismaAccountRepository + PrismaDeviceRepository
//
// Durable account/device identity persistence only (no auth logic, no
// Electron, no SecretStore access). Refresh tokens NEVER persist here; they
// live exclusively in the OS SecretStore under app/account/<id>/refresh-token.
//
// No secret columns exist on these tables. As defense-in-depth, identity
// fields (displayName/email/deviceName) are scanned for secret-looking
// content and refused before persistence, and text fields are truncated to
// their durable bounds.
//
// The Prisma delegates are reached through a structural view of
// StorageDatabase.client so this module compiles against the checked-in
// client while the accounts_sync migration rolls out.

import type { StorageDatabase } from "../client/database.js";

export interface AccountRow {
  accountId: string;
  displayName: string;
  email?: string | null;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}

export interface DeviceRow {
  deviceId: string;
  accountId: string;
  deviceName: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
}

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountValidationError";
  }
}

export class AccountSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountSecretError";
  }
}

export const MAX_ACCOUNT_DISPLAY_NAME_LENGTH = 120;
export const MAX_ACCOUNT_EMAIL_LENGTH = 256;
export const MAX_DEVICE_NAME_LENGTH = 120;
export const MAX_DEVICE_PLATFORM_LENGTH = 64;
export const ACCOUNT_SCHEMA_VERSION = 1;

const SECRET_PATTERN =
  /(api[_-]?key|secret|bearer\s+[A-Za-z0-9._~-]|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bap]-|gh[pousr]_|sk-(live|test)-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|password\s*[:=]|passwd\s*[:=]|client[_-]?secret|access[_-]?token|refresh[_-]?token|aws[_-]?secret)/i;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function assertNoSecrets(fieldName: string, value: string | null | undefined): void {
  if (value == null || value.length === 0) {
    return;
  }
  if (SECRET_PATTERN.test(value)) {
    throw new AccountSecretError(
      `Refusing to persist account record: field "${fieldName}" appears to contain a secret`,
    );
  }
}

function isP2025(err: unknown): boolean {
  if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2025") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("P2025") || message.includes("Record to delete does not exist");
}

interface AccountDbRow {
  accountId: string;
  displayName: string;
  email: string | null;
  createdAt: bigint;
  updatedAt: bigint;
  schemaVersion: number;
}

interface DeviceDbRow {
  deviceId: string;
  accountId: string;
  deviceName: string;
  platform: string;
  createdAt: bigint;
  lastSeenAt: bigint;
}

interface AccountDelegate {
  upsert(args: {
    where: { accountId: string };
    create: unknown;
    update: unknown;
  }): Promise<unknown>;
  findUnique(args: { where: { accountId: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown; orderBy?: unknown }): Promise<unknown[]>;
  delete(args: { where: { accountId: string } }): Promise<unknown>;
}

interface DeviceDelegate {
  upsert(args: { where: { deviceId: string }; create: unknown; update: unknown }): Promise<unknown>;
  findUnique(args: { where: { deviceId: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown; orderBy?: unknown }): Promise<unknown[]>;
  update(args: { where: { deviceId: string }; data: unknown }): Promise<unknown>;
  delete(args: { where: { deviceId: string } }): Promise<unknown>;
}

function delegates(db: StorageDatabase): {
  accountRecord: AccountDelegate;
  deviceRecord: DeviceDelegate;
} {
  const client = db.client as unknown as {
    accountRecord: AccountDelegate;
    deviceRecord: DeviceDelegate;
  };
  return { accountRecord: client.accountRecord, deviceRecord: client.deviceRecord };
}

function toAccountRow(dbRow: AccountDbRow): AccountRow {
  return {
    accountId: dbRow.accountId,
    displayName: dbRow.displayName,
    email: dbRow.email,
    createdAt: Number(dbRow.createdAt),
    updatedAt: Number(dbRow.updatedAt),
    schemaVersion: dbRow.schemaVersion,
  };
}

function toDeviceRow(dbRow: DeviceDbRow): DeviceRow {
  return {
    deviceId: dbRow.deviceId,
    accountId: dbRow.accountId,
    deviceName: dbRow.deviceName,
    platform: dbRow.platform,
    createdAt: Number(dbRow.createdAt),
    lastSeenAt: Number(dbRow.lastSeenAt),
  };
}

function sanitizeAccountForWrite(record: AccountRow): AccountDbRow {
  if (!record.accountId || record.accountId.trim().length === 0) {
    throw new AccountValidationError("accountId must be a non-empty string");
  }
  const displayName = truncate((record.displayName ?? "").trim(), MAX_ACCOUNT_DISPLAY_NAME_LENGTH);
  if (displayName.length === 0) {
    throw new AccountValidationError(
      "displayName must be a non-empty string of at most 120 characters",
    );
  }
  const email =
    record.email == null || record.email.trim().length === 0
      ? null
      : truncate(record.email.trim(), MAX_ACCOUNT_EMAIL_LENGTH);
  assertNoSecrets("displayName", displayName);
  assertNoSecrets("email", email);
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
    throw new AccountValidationError("account timestamps must be finite epoch milliseconds");
  }
  return {
    accountId: record.accountId,
    displayName,
    email,
    createdAt: BigInt(Math.floor(record.createdAt)),
    updatedAt: BigInt(Math.floor(record.updatedAt)),
    schemaVersion: record.schemaVersion ?? ACCOUNT_SCHEMA_VERSION,
  };
}

function sanitizeDeviceForWrite(record: DeviceRow): DeviceDbRow {
  if (!record.deviceId || record.deviceId.trim().length === 0) {
    throw new DeviceValidationError("deviceId must be a non-empty string");
  }
  if (!record.accountId || record.accountId.trim().length === 0) {
    throw new DeviceValidationError("accountId must be a non-empty string");
  }
  const deviceName =
    truncate((record.deviceName ?? "").trim(), MAX_DEVICE_NAME_LENGTH) || "desktop";
  const platform =
    truncate((record.platform ?? "").trim(), MAX_DEVICE_PLATFORM_LENGTH) || "unknown";
  assertNoSecrets("deviceName", deviceName);
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.lastSeenAt)) {
    throw new DeviceValidationError("device timestamps must be finite epoch milliseconds");
  }
  return {
    deviceId: record.deviceId,
    accountId: record.accountId,
    deviceName,
    platform,
    createdAt: BigInt(Math.floor(record.createdAt)),
    lastSeenAt: BigInt(Math.floor(record.lastSeenAt)),
  };
}

export class DeviceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceValidationError";
  }
}

export class PrismaAccountRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async upsert(record: AccountRow): Promise<void> {
    const data = sanitizeAccountForWrite(record);
    const { accountId, ...rest } = data;
    await delegates(this._db).accountRecord.upsert({
      where: { accountId },
      create: { accountId, ...rest },
      update: { ...rest },
    });
  }

  async get(accountId: string): Promise<AccountRow | null> {
    if (!accountId || accountId.trim().length === 0) {
      throw new AccountValidationError("accountId must be a non-empty string");
    }
    const row = (await delegates(this._db).accountRecord.findUnique({
      where: { accountId },
    })) as unknown as AccountDbRow | null;
    return row ? toAccountRow(row) : null;
  }

  async list(): Promise<AccountRow[]> {
    const rows = (await delegates(this._db).accountRecord.findMany({
      orderBy: { createdAt: "desc" },
    })) as unknown as AccountDbRow[];
    return rows.map(toAccountRow);
  }

  async current(): Promise<AccountRow | null> {
    const rows = await this.list();
    return rows.length > 0 ? (rows[0] as AccountRow) : null;
  }

  async remove(accountId: string): Promise<boolean> {
    if (!accountId || accountId.trim().length === 0) {
      throw new AccountValidationError("accountId must be a non-empty string");
    }
    try {
      await delegates(this._db).accountRecord.delete({ where: { accountId } });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }
}

export class PrismaDeviceRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async upsert(record: DeviceRow): Promise<void> {
    const data = sanitizeDeviceForWrite(record);
    const { deviceId, ...rest } = data;
    await delegates(this._db).deviceRecord.upsert({
      where: { deviceId },
      create: { deviceId, ...rest },
      update: { ...rest },
    });
  }

  async get(deviceId: string): Promise<DeviceRow | null> {
    if (!deviceId || deviceId.trim().length === 0) {
      throw new DeviceValidationError("deviceId must be a non-empty string");
    }
    const row = (await delegates(this._db).deviceRecord.findUnique({
      where: { deviceId },
    })) as unknown as DeviceDbRow | null;
    return row ? toDeviceRow(row) : null;
  }

  async listByAccount(accountId: string): Promise<DeviceRow[]> {
    if (!accountId || accountId.trim().length === 0) {
      throw new DeviceValidationError("accountId must be a non-empty string");
    }
    const rows = (await delegates(this._db).deviceRecord.findMany({
      where: { accountId },
      orderBy: { lastSeenAt: "desc" },
    })) as unknown as DeviceDbRow[];
    return rows.filter((row) => row.accountId === accountId).map(toDeviceRow);
  }

  async touchLastSeen(deviceId: string, atMs?: number): Promise<boolean> {
    if (!deviceId || deviceId.trim().length === 0) {
      throw new DeviceValidationError("deviceId must be a non-empty string");
    }
    const at = atMs ?? Date.now();
    if (!Number.isFinite(at)) {
      throw new DeviceValidationError("lastSeenAt must be finite epoch milliseconds");
    }
    try {
      await delegates(this._db).deviceRecord.update({
        where: { deviceId },
        data: { lastSeenAt: BigInt(Math.floor(at)) },
      });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }

  /**
   * Stable device identity: returns the existing device row for the account
   * when a matching deviceId is known, otherwise creates one with the
   * caller-supplied stable id. Callers persist the stable id per
   * installation so the same device reuses its row across restarts.
   */
  async getOrCreateDevice(input: {
    deviceId: string;
    accountId: string;
    deviceName?: string;
    platform?: string;
    nowMs?: number;
  }): Promise<DeviceRow> {
    const deviceId = (input.deviceId ?? "").trim();
    const accountId = (input.accountId ?? "").trim();
    if (deviceId.length === 0) {
      throw new DeviceValidationError("deviceId must be a non-empty string");
    }
    if (accountId.length === 0) {
      throw new DeviceValidationError("accountId must be a non-empty string");
    }
    const nowMs = input.nowMs ?? Date.now();
    const existing = await this.get(deviceId).catch(() => null);
    if (existing && existing.accountId === accountId) {
      await this.touchLastSeen(deviceId, nowMs).catch(() => false);
      const refreshed = await this.get(deviceId).catch(() => existing);
      return refreshed ?? existing;
    }
    const row: DeviceRow = {
      deviceId,
      accountId,
      deviceName: (input.deviceName ?? "desktop").trim() || "desktop",
      platform: (input.platform ?? "unknown").trim() || "unknown",
      createdAt: nowMs,
      lastSeenAt: nowMs,
    };
    await this.upsert(row);
    const created = await this.get(deviceId);
    if (!created) {
      throw new DeviceValidationError("device storage unavailable");
    }
    return created;
  }

  async remove(deviceId: string): Promise<boolean> {
    if (!deviceId || deviceId.trim().length === 0) {
      throw new DeviceValidationError("deviceId must be a non-empty string");
    }
    try {
      await delegates(this._db).deviceRecord.delete({ where: { deviceId } });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }
}
