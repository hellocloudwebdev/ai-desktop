// PR43: packages/storage — PrismaBackgroundTaskRepository Implementation
//
// Durable background-task persistence only (no execution logic).
// Project scoping is enforced on listByProject; terminal statuses are
// "completed" | "failed" | "cancelled".
//
// No secret columns exist on this table. As defense-in-depth, inputs are
// scanned for secret-looking content and refused before persistence.

import type { StorageDatabase } from "../client/database.js";

export interface BackgroundTaskRow {
  taskId: string;
  conversationId: string;
  projectId: string;
  title: string;
  goal: string;
  mode: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  attempt: number;
  lastError?: string | null;
  resultSummary?: string | null;
  nodeCount: number;
  schemaVersion: number;
}

export interface BackgroundTaskStatusPatch {
  lastError?: string | null;
  resultSummary?: string | null;
  nodeCount?: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

export class BackgroundTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundTaskValidationError";
  }
}

export class BackgroundTaskSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundTaskSecretError";
  }
}

const MAX_TITLE_LENGTH = 120;
const MAX_GOAL_LENGTH = 4000;
const MAX_LAST_ERROR_LENGTH = 2000;
const MAX_RESULT_SUMMARY_LENGTH = 8000;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Local secret guard (same semantics as the sibling background module; kept
// local so storage does not depend on ai-core task code that may not exist).
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
    throw new BackgroundTaskSecretError(
      `Refusing to persist background task: field "${fieldName}" appears to contain a secret`,
    );
  }
}

interface BackgroundTaskDbRow {
  taskId: string;
  conversationId: string;
  projectId: string;
  title: string;
  goal: string;
  mode: string;
  status: string;
  createdAt: bigint;
  updatedAt: bigint;
  startedAt: bigint | null;
  completedAt: bigint | null;
  attempt: number;
  lastError: string | null;
  resultSummary: string | null;
  nodeCount: number;
  schemaVersion: number;
}

function toRow(dbRow: BackgroundTaskDbRow): BackgroundTaskRow {
  return {
    taskId: dbRow.taskId,
    conversationId: dbRow.conversationId,
    projectId: dbRow.projectId,
    title: dbRow.title,
    goal: dbRow.goal,
    mode: dbRow.mode,
    status: dbRow.status,
    createdAt: Number(dbRow.createdAt),
    updatedAt: Number(dbRow.updatedAt),
    startedAt: dbRow.startedAt == null ? null : Number(dbRow.startedAt),
    completedAt: dbRow.completedAt == null ? null : Number(dbRow.completedAt),
    attempt: dbRow.attempt,
    lastError: dbRow.lastError,
    resultSummary: dbRow.resultSummary,
    nodeCount: dbRow.nodeCount,
    schemaVersion: dbRow.schemaVersion,
  };
}

function sanitizeForWrite(record: BackgroundTaskRow): {
  taskId: string;
  conversationId: string;
  projectId: string;
  title: string;
  goal: string;
  mode: string;
  status: string;
  createdAt: bigint;
  updatedAt: bigint;
  startedAt: bigint | null;
  completedAt: bigint | null;
  attempt: number;
  lastError: string | null;
  resultSummary: string | null;
  nodeCount: number;
  schemaVersion: number;
} {
  if (!record.taskId || record.taskId.trim().length === 0) {
    throw new BackgroundTaskValidationError("taskId must be a non-empty string");
  }
  if (!record.projectId || record.projectId.trim().length === 0) {
    throw new BackgroundTaskValidationError("projectId must be a non-empty string");
  }

  const title = truncate(record.title ?? "", MAX_TITLE_LENGTH);
  const goal = truncate(record.goal ?? "", MAX_GOAL_LENGTH);
  const lastError =
    record.lastError == null ? null : truncate(record.lastError, MAX_LAST_ERROR_LENGTH);
  const resultSummary =
    record.resultSummary == null ? null : truncate(record.resultSummary, MAX_RESULT_SUMMARY_LENGTH);

  assertNoSecrets("title", title);
  assertNoSecrets("goal", goal);
  assertNoSecrets("lastError", lastError);
  assertNoSecrets("resultSummary", resultSummary);

  return {
    taskId: record.taskId,
    conversationId: record.conversationId,
    projectId: record.projectId,
    title,
    goal,
    mode: record.mode || "background",
    status: record.status,
    createdAt: BigInt(record.createdAt),
    updatedAt: BigInt(record.updatedAt),
    startedAt: record.startedAt == null ? null : BigInt(record.startedAt),
    completedAt: record.completedAt == null ? null : BigInt(record.completedAt),
    attempt: record.attempt,
    lastError,
    resultSummary,
    nodeCount: record.nodeCount,
    schemaVersion: record.schemaVersion,
  };
}

export class PrismaBackgroundTaskRepository {
  private readonly _db: StorageDatabase;

  constructor(database: StorageDatabase) {
    this._db = database;
  }

  async upsert(record: BackgroundTaskRow): Promise<void> {
    const data = sanitizeForWrite(record);
    const { taskId, ...rest } = data;
    await this._db.client.backgroundTaskRecord.upsert({
      where: { taskId },
      create: { taskId, ...rest },
      update: { ...rest },
    });
  }

  async get(taskId: string): Promise<BackgroundTaskRow | null> {
    if (!taskId || taskId.trim().length === 0) {
      throw new BackgroundTaskValidationError("taskId must be a non-empty string");
    }
    const row = await this._db.client.backgroundTaskRecord.findUnique({
      where: { taskId },
    });
    return row ? toRow(row as unknown as BackgroundTaskDbRow) : null;
  }

  async listByProject(projectId: string): Promise<BackgroundTaskRow[]> {
    if (!projectId || projectId.trim().length === 0) {
      throw new BackgroundTaskValidationError("projectId must be a non-empty string");
    }
    const rows = await this._db.client.backgroundTaskRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => toRow(row as unknown as BackgroundTaskDbRow));
  }

  async listUnfinished(): Promise<BackgroundTaskRow[]> {
    const rows = await this._db.client.backgroundTaskRecord.findMany({
      where: { status: { notIn: ["completed", "failed", "cancelled"] } },
      orderBy: { createdAt: "desc" },
    });
    return (rows as unknown as BackgroundTaskDbRow[])
      .filter((row) => !TERMINAL_STATUSES.has(row.status))
      .map(toRow);
  }

  async remove(taskId: string): Promise<boolean> {
    if (!taskId || taskId.trim().length === 0) {
      throw new BackgroundTaskValidationError("taskId must be a non-empty string");
    }
    try {
      await this._db.client.backgroundTaskRecord.delete({ where: { taskId } });
      return true;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2025") {
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("P2025") || message.includes("Record to delete does not exist")) {
        return false;
      }
      throw err;
    }
  }

  async updateStatus(
    taskId: string,
    status: string,
    patch?: BackgroundTaskStatusPatch,
  ): Promise<boolean> {
    if (!taskId || taskId.trim().length === 0) {
      throw new BackgroundTaskValidationError("taskId must be a non-empty string");
    }
    if (!status || status.trim().length === 0) {
      throw new BackgroundTaskValidationError("status must be a non-empty string");
    }

    const lastError =
      patch?.lastError === undefined
        ? undefined
        : patch.lastError === null
          ? null
          : truncate(patch.lastError, MAX_LAST_ERROR_LENGTH);
    const resultSummary =
      patch?.resultSummary === undefined
        ? undefined
        : patch.resultSummary === null
          ? null
          : truncate(patch.resultSummary, MAX_RESULT_SUMMARY_LENGTH);

    assertNoSecrets("lastError", lastError ?? undefined);
    assertNoSecrets("resultSummary", resultSummary ?? undefined);

    const data: Record<string, unknown> = {
      status,
      updatedAt: BigInt(Date.now()),
    };
    if (lastError !== undefined) {
      data["lastError"] = lastError;
    }
    if (resultSummary !== undefined) {
      data["resultSummary"] = resultSummary;
    }
    if (patch?.nodeCount !== undefined) {
      data["nodeCount"] = patch.nodeCount;
    }
    if (patch?.startedAt !== undefined) {
      data["startedAt"] = patch.startedAt == null ? null : BigInt(patch.startedAt);
    }
    if (patch?.completedAt !== undefined) {
      data["completedAt"] = patch.completedAt == null ? null : BigInt(patch.completedAt);
    }

    try {
      await this._db.client.backgroundTaskRecord.update({ where: { taskId }, data });
      return true;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "P2025") {
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("P2025") || message.includes("Record to update not found")) {
        return false;
      }
      throw err;
    }
  }
}
