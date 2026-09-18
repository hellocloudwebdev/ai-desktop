// PR44: packages/storage — PrismaScheduledTaskRepository + PrismaScheduledRunRepository
//
// Durable scheduled-task persistence only (no execution logic, no Electron).
// Project scoping is enforced on listByProject; run history is
// retention-pruned per schedule (pruneRuns keeps the latest N rows).
//
// No secret columns exist on these tables. As defense-in-depth, inputs are
// scanned for secret-looking content and refused before persistence, and
// text fields are truncated to their durable bounds.
//
// The Prisma delegates are reached through a structural view of
// StorageDatabase.client so this module compiles against the checked-in
// client while the scheduled_tasks migration rolls out.

import type { StorageDatabase } from "../client/database.js";

export interface ScheduledTaskRow {
  scheduleId: string;
  projectId: string;
  name: string;
  description?: string | null;
  prompt: string;
  kind: string;
  configJson: string;
  timezone: string;
  enabled: boolean;
  missedPolicy: string;
  overlapPolicy: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastRunStatus?: string | null;
  runCount: number;
  missedCount: number;
  schemaVersion: number;
}

export interface ScheduledRunRow {
  runId: string;
  scheduleId: string;
  projectId: string;
  backgroundTaskId?: string | null;
  trigger: string;
  status: string;
  scheduledFor: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
}

export interface ScheduledRunPatch {
  backgroundTaskId?: string | null;
  status?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
}

export class ScheduledTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTaskValidationError";
  }
}

export class ScheduledTaskSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledTaskSecretError";
  }
}

export const MAX_SCHEDULE_NAME_LENGTH = 120;
export const MAX_SCHEDULE_PROMPT_LENGTH = 4000;
export const MAX_SCHEDULE_DESCRIPTION_LENGTH = 2000;
export const MAX_SCHEDULE_CONFIG_LENGTH = 16_000;
export const MAX_SCHEDULE_ERROR_LENGTH = 2000;

// Canonical unfinished run statuses (ai-core ScheduledRunStatusSchema):
// pending/running. Terminal: completed/failed/skipped/cancelled.
const RUN_UNFINISHED_STATUSES = new Set(["pending", "running"]);

// Local secret guard (same semantics as the sibling background module; kept
// local so storage does not depend on ai-core task code).
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
    throw new ScheduledTaskSecretError(
      `Refusing to persist scheduled task: field "${fieldName}" appears to contain a secret`,
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

interface ScheduledTaskDbRow {
  scheduleId: string;
  projectId: string;
  name: string;
  description: string | null;
  prompt: string;
  kind: string;
  configJson: string;
  timezone: string;
  enabled: boolean;
  missedPolicy: string;
  overlapPolicy: string;
  createdAt: bigint;
  updatedAt: bigint;
  nextRunAt: bigint | null;
  lastRunAt: bigint | null;
  lastRunStatus: string | null;
  runCount: number;
  missedCount: number;
  schemaVersion: number;
}

interface ScheduledRunDbRow {
  runId: string;
  scheduleId: string;
  projectId: string;
  backgroundTaskId: string | null;
  trigger: string;
  status: string;
  scheduledFor: bigint;
  startedAt: bigint | null;
  finishedAt: bigint | null;
  error: string | null;
}

interface ScheduledTaskDelegate {
  upsert(args: {
    where: { scheduleId: string };
    create: unknown;
    update: unknown;
  }): Promise<unknown>;
  findUnique(args: { where: { scheduleId: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown; orderBy?: unknown }): Promise<unknown[]>;
  delete(args: { where: { scheduleId: string } }): Promise<unknown>;
}

interface ScheduledRunDelegate {
  create(args: { data: unknown }): Promise<unknown>;
  findUnique(args: { where: { runId: string } }): Promise<unknown>;
  findMany(args?: { where?: unknown; orderBy?: unknown; take?: number }): Promise<unknown[]>;
  update(args: { where: { runId: string }; data: unknown }): Promise<unknown>;
  deleteMany(args: { where: unknown }): Promise<{ count: number }>;
}

function delegates(db: StorageDatabase): {
  scheduledTask: ScheduledTaskDelegate;
  scheduledRun: ScheduledRunDelegate;
} {
  const client = db.client as unknown as {
    scheduledTask: ScheduledTaskDelegate;
    scheduledRun: ScheduledRunDelegate;
  };
  return { scheduledTask: client.scheduledTask, scheduledRun: client.scheduledRun };
}

function toTaskRow(dbRow: ScheduledTaskDbRow): ScheduledTaskRow {
  return {
    scheduleId: dbRow.scheduleId,
    projectId: dbRow.projectId,
    name: dbRow.name,
    description: dbRow.description,
    prompt: dbRow.prompt,
    kind: dbRow.kind,
    configJson: dbRow.configJson,
    timezone: dbRow.timezone,
    enabled: dbRow.enabled,
    missedPolicy: dbRow.missedPolicy,
    overlapPolicy: dbRow.overlapPolicy,
    createdAt: Number(dbRow.createdAt),
    updatedAt: Number(dbRow.updatedAt),
    nextRunAt: dbRow.nextRunAt == null ? null : Number(dbRow.nextRunAt),
    lastRunAt: dbRow.lastRunAt == null ? null : Number(dbRow.lastRunAt),
    lastRunStatus: dbRow.lastRunStatus,
    runCount: dbRow.runCount,
    missedCount: dbRow.missedCount,
    schemaVersion: dbRow.schemaVersion,
  };
}

function toRunRow(dbRow: ScheduledRunDbRow): ScheduledRunRow {
  return {
    runId: dbRow.runId,
    scheduleId: dbRow.scheduleId,
    projectId: dbRow.projectId,
    backgroundTaskId: dbRow.backgroundTaskId,
    trigger: dbRow.trigger,
    status: dbRow.status,
    scheduledFor: Number(dbRow.scheduledFor),
    startedAt: dbRow.startedAt == null ? null : Number(dbRow.startedAt),
    finishedAt: dbRow.finishedAt == null ? null : Number(dbRow.finishedAt),
    error: dbRow.error,
  };
}

function sanitizeTaskForWrite(record: ScheduledTaskRow): ScheduledTaskDbRow {
  if (!record.scheduleId || record.scheduleId.trim().length === 0) {
    throw new ScheduledTaskValidationError("scheduleId must be a non-empty string");
  }
  if (!record.projectId || record.projectId.trim().length === 0) {
    throw new ScheduledTaskValidationError("projectId must be a non-empty string");
  }
  const name = truncate(record.name ?? "", MAX_SCHEDULE_NAME_LENGTH);
  const prompt = truncate(record.prompt ?? "", MAX_SCHEDULE_PROMPT_LENGTH);
  const description =
    record.description == null
      ? null
      : truncate(record.description, MAX_SCHEDULE_DESCRIPTION_LENGTH);
  const configJson = truncate(record.configJson ?? "", MAX_SCHEDULE_CONFIG_LENGTH);
  assertNoSecrets("name", name);
  assertNoSecrets("prompt", prompt);
  assertNoSecrets("description", description);
  return {
    scheduleId: record.scheduleId,
    projectId: record.projectId,
    name,
    description,
    prompt,
    kind: record.kind,
    configJson,
    timezone: record.timezone || "UTC",
    enabled: record.enabled,
    missedPolicy: record.missedPolicy,
    overlapPolicy: record.overlapPolicy,
    createdAt: BigInt(record.createdAt),
    updatedAt: BigInt(record.updatedAt),
    nextRunAt: record.nextRunAt == null ? null : BigInt(record.nextRunAt),
    lastRunAt: record.lastRunAt == null ? null : BigInt(record.lastRunAt),
    lastRunStatus: record.lastRunStatus ?? null,
    runCount: record.runCount,
    missedCount: record.missedCount,
    schemaVersion: record.schemaVersion,
  };
}

function sanitizeRunForWrite(record: ScheduledRunRow): ScheduledRunDbRow {
  if (!record.runId || record.runId.trim().length === 0) {
    throw new ScheduledTaskValidationError("runId must be a non-empty string");
  }
  if (!record.scheduleId || record.scheduleId.trim().length === 0) {
    throw new ScheduledTaskValidationError("scheduleId must be a non-empty string");
  }
  if (!record.projectId || record.projectId.trim().length === 0) {
    throw new ScheduledTaskValidationError("projectId must be a non-empty string");
  }
  const error = record.error == null ? null : truncate(record.error, MAX_SCHEDULE_ERROR_LENGTH);
  assertNoSecrets("error", error);
  return {
    runId: record.runId,
    scheduleId: record.scheduleId,
    projectId: record.projectId,
    backgroundTaskId: record.backgroundTaskId ?? null,
    trigger: record.trigger,
    status: record.status,
    scheduledFor: BigInt(record.scheduledFor),
    startedAt: record.startedAt == null ? null : BigInt(record.startedAt),
    finishedAt: record.finishedAt == null ? null : BigInt(record.finishedAt),
    error,
  };
}

export class PrismaScheduledTaskRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async upsert(record: ScheduledTaskRow): Promise<void> {
    const data = sanitizeTaskForWrite(record);
    const { scheduleId, ...rest } = data;
    await delegates(this._db).scheduledTask.upsert({
      where: { scheduleId },
      create: { scheduleId, ...rest },
      update: { ...rest },
    });
  }

  async get(scheduleId: string): Promise<ScheduledTaskRow | null> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ScheduledTaskValidationError("scheduleId must be a non-empty string");
    }
    const row = (await delegates(this._db).scheduledTask.findUnique({
      where: { scheduleId },
    })) as unknown as ScheduledTaskDbRow | null;
    return row ? toTaskRow(row) : null;
  }

  async listByProject(projectId: string): Promise<ScheduledTaskRow[]> {
    if (!projectId || projectId.trim().length === 0) {
      throw new ScheduledTaskValidationError("projectId must be a non-empty string");
    }
    const rows = (await delegates(this._db).scheduledTask.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    })) as unknown as ScheduledTaskDbRow[];
    return rows.map(toTaskRow);
  }

  async listAll(): Promise<ScheduledTaskRow[]> {
    const rows = (await delegates(this._db).scheduledTask.findMany({
      orderBy: { createdAt: "desc" },
    })) as unknown as ScheduledTaskDbRow[];
    return rows.map(toTaskRow);
  }

  async listEnabled(): Promise<ScheduledTaskRow[]> {
    const rows = (await delegates(this._db).scheduledTask.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "desc" },
    })) as unknown as ScheduledTaskDbRow[];
    return rows.filter((row) => row.enabled).map(toTaskRow);
  }

  async remove(scheduleId: string): Promise<boolean> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ScheduledTaskValidationError("scheduleId must be a non-empty string");
    }
    try {
      await delegates(this._db).scheduledTask.delete({ where: { scheduleId } });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }
}

export class PrismaScheduledRunRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async create(record: ScheduledRunRow): Promise<void> {
    const data = sanitizeRunForWrite(record);
    await delegates(this._db).scheduledRun.create({ data });
  }

  async get(runId: string): Promise<ScheduledRunRow | null> {
    if (!runId || runId.trim().length === 0) {
      throw new ScheduledTaskValidationError("runId must be a non-empty string");
    }
    const row = (await delegates(this._db).scheduledRun.findUnique({
      where: { runId },
    })) as unknown as ScheduledRunDbRow | null;
    return row ? toRunRow(row) : null;
  }

  async listBySchedule(scheduleId: string, limit?: number): Promise<ScheduledRunRow[]> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ScheduledTaskValidationError("scheduleId must be a non-empty string");
    }
    const take = limit === undefined ? undefined : Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = (await delegates(this._db).scheduledRun.findMany({
      where: { scheduleId },
      orderBy: { scheduledFor: "desc" },
      ...(take === undefined ? {} : { take }),
    })) as unknown as ScheduledRunDbRow[];
    return rows
      .filter((row) => row.scheduleId === scheduleId)
      .sort((a, b) => Number(b.scheduledFor - a.scheduledFor))
      .slice(0, take ?? rows.length)
      .map(toRunRow);
  }

  async listUnfinished(scheduleId?: string): Promise<ScheduledRunRow[]> {
    const rows = (await delegates(this._db).scheduledRun.findMany({
      where:
        scheduleId === undefined
          ? { status: { in: [...RUN_UNFINISHED_STATUSES] } }
          : { scheduleId, status: { in: [...RUN_UNFINISHED_STATUSES] } },
      orderBy: { scheduledFor: "desc" },
    })) as unknown as ScheduledRunDbRow[];
    return rows
      .filter(
        (row) =>
          RUN_UNFINISHED_STATUSES.has(row.status) &&
          (scheduleId === undefined || row.scheduleId === scheduleId),
      )
      .map(toRunRow);
  }

  async update(runId: string, patch: ScheduledRunPatch): Promise<boolean> {
    if (!runId || runId.trim().length === 0) {
      throw new ScheduledTaskValidationError("runId must be a non-empty string");
    }
    const error =
      patch.error === undefined
        ? undefined
        : patch.error === null
          ? null
          : truncate(patch.error, MAX_SCHEDULE_ERROR_LENGTH);
    assertNoSecrets("error", error ?? undefined);
    const data: Record<string, unknown> = {};
    if (patch.backgroundTaskId !== undefined) {
      data["backgroundTaskId"] = patch.backgroundTaskId;
    }
    if (patch.status !== undefined) {
      data["status"] = patch.status;
    }
    if (patch.startedAt !== undefined) {
      data["startedAt"] = patch.startedAt == null ? null : BigInt(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      data["finishedAt"] = patch.finishedAt == null ? null : BigInt(patch.finishedAt);
    }
    if (error !== undefined) {
      data["error"] = error;
    }
    try {
      await delegates(this._db).scheduledRun.update({ where: { runId }, data });
      return true;
    } catch (err) {
      if (isP2025(err)) return false;
      throw err;
    }
  }

  /**
   * Retention prune: keeps the latest `keepLatest` runs for a schedule
   * (by scheduledFor desc) and deletes the rest. Returns the deleted count.
   */
  async pruneRuns(scheduleId: string, keepLatest: number): Promise<number> {
    if (!scheduleId || scheduleId.trim().length === 0) {
      throw new ScheduledTaskValidationError("scheduleId must be a non-empty string");
    }
    const keep = Math.max(0, Math.floor(keepLatest));
    const rows = (await delegates(this._db).scheduledRun.findMany({
      where: { scheduleId },
      orderBy: { scheduledFor: "desc" },
    })) as unknown as ScheduledRunDbRow[];
    const ordered = rows
      .filter((row) => row.scheduleId === scheduleId)
      .sort((a, b) => {
        const byTime = Number(b.scheduledFor - a.scheduledFor);
        if (byTime !== 0) return byTime;
        // Same-instant ties (rapid manual runs) fall back to runId order so
        // the victim set is deterministic across databases.
        return b.runId < a.runId ? -1 : b.runId > a.runId ? 1 : 0;
      });
    const stale = ordered.slice(keep);
    if (stale.length === 0) return 0;
    const staleIds = new Set(stale.map((row) => row.runId));
    const result = await delegates(this._db).scheduledRun.deleteMany({
      where: { scheduleId, runId: { in: [...staleIds] } },
    });
    return result.count;
  }
}
