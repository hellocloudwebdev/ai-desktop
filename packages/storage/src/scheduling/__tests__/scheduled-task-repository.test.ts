// PR44: packages/storage - Scheduled Task Repository Tests
//
// Covers schedule upsert/get round-trip, project isolation, enabled
// filtering, run create/get/update, canonical unfinished filtering
// (pending/running only), retention pruning, remove-preserves-runs,
// truncation bounds, empty-id rejection, and secret refusal. File-backed
// tmp DB seeded with CREATE TABLEs so the tests run without a global
// migrate step (mirrors the PR43 background-task repository tests).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { StorageDatabase } from "../../client/database.js";
import {
  PrismaScheduledRunRepository,
  PrismaScheduledTaskRepository,
  ScheduledTaskSecretError,
  ScheduledTaskValidationError,
  type ScheduledRunRow,
  type ScheduledTaskRow,
} from "../scheduled-task-repository.js";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
    "scheduleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "prompt" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "missedPolicy" TEXT NOT NULL DEFAULT 'skip',
    "overlapPolicy" TEXT NOT NULL DEFAULT 'skip',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "nextRunAt" BIGINT,
    "lastRunAt" BIGINT,
    "lastRunStatus" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "missedCount" INTEGER NOT NULL DEFAULT 0,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY ("scheduleId")
);
CREATE TABLE IF NOT EXISTS "scheduled_runs" (
    "runId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "backgroundTaskId" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduledFor" BIGINT NOT NULL,
    "startedAt" BIGINT,
    "finishedAt" BIGINT,
    "error" TEXT,
    PRIMARY KEY ("runId")
);
`;

let dir: string;
let db: StorageDatabase;
let tasks: PrismaScheduledTaskRepository;
let runs: PrismaScheduledRunRepository;

let seq = 0;
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq).padStart(6, "0")}${Date.now().toString(36).toUpperCase()}`;
}

function makeTask(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  const now = Date.now();
  return {
    scheduleId: uid("SCH"),
    projectId: "proj-a",
    name: "Hourly summary",
    description: null,
    prompt: "Summarize what changed.",
    kind: "interval",
    configJson: JSON.stringify({ kind: "interval", intervalMs: 3_600_000 }),
    timezone: "UTC",
    enabled: true,
    missedPolicy: "skip",
    overlapPolicy: "skip",
    createdAt: now,
    updatedAt: now,
    nextRunAt: now + 3_600_000,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    missedCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeRun(scheduleId: string, overrides: Partial<ScheduledRunRow> = {}): ScheduledRunRow {
  const now = Date.now();
  return {
    runId: uid("RUN"),
    scheduleId,
    projectId: "proj-a",
    backgroundTaskId: null,
    trigger: "scheduled",
    status: "pending",
    scheduledFor: now,
    startedAt: now,
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-tasks-repo-"));
  db = new StorageDatabase({ url: `file:${path.join(dir, "test.db")}` });
  await db.initialize();
  const client = (
    db as unknown as { client: { $executeRawUnsafe: (sql: string) => Promise<unknown> } }
  ).client;
  for (const statement of CREATE_SQL.split(";")) {
    const sql = statement.trim();
    if (sql.length > 0) await client.$executeRawUnsafe(sql);
  }
  tasks = new PrismaScheduledTaskRepository(db);
  runs = new PrismaScheduledRunRepository(db);
});

afterAll(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("storage: scheduled task persistence (PR44)", () => {
  it("round-trips a schedule upsert/get", async () => {
    const record = makeTask();
    await tasks.upsert(record);
    const loaded = await tasks.get(record.scheduleId);
    expect(loaded?.name).toBe("Hourly summary");
    expect(loaded?.timezone).toBe("UTC");
    expect(loaded?.enabled).toBe(true);
    expect(loaded?.nextRunAt).toBe(record.nextRunAt);
  });

  it("isolates schedules by project", async () => {
    await tasks.upsert(makeTask({ projectId: "proj-iso-a" }));
    await tasks.upsert(makeTask({ projectId: "proj-iso-b" }));
    const a = await tasks.listByProject("proj-iso-a");
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((row) => row.projectId === "proj-iso-a")).toBe(true);
  });

  it("lists only enabled schedules", async () => {
    const on = makeTask({ projectId: "proj-enabled" });
    const off = makeTask({ projectId: "proj-enabled", enabled: false });
    await tasks.upsert(on);
    await tasks.upsert(off);
    const enabled = await tasks.listEnabled();
    expect(enabled.find((row) => row.scheduleId === off.scheduleId)).toBeUndefined();
    expect(enabled.find((row) => row.scheduleId === on.scheduleId)).toBeDefined();
  });

  it("creates, gets, and updates runs", async () => {
    const schedule = makeTask();
    await tasks.upsert(schedule);
    const run = makeRun(schedule.scheduleId);
    await runs.create(run);
    expect((await runs.get(run.runId))?.status).toBe("pending");
    expect(await runs.update(run.runId, { status: "completed", finishedAt: Date.now() })).toBe(
      true,
    );
    expect((await runs.get(run.runId))?.status).toBe("completed");
    expect(await runs.update("missing-run", { status: "failed" })).toBe(false);
  });

  it("treats only pending/running as unfinished (canonical statuses)", async () => {
    const schedule = makeTask();
    await tasks.upsert(schedule);
    await runs.create(makeRun(schedule.scheduleId, { status: "pending" }));
    await runs.create(makeRun(schedule.scheduleId, { status: "running" }));
    await runs.create(makeRun(schedule.scheduleId, { status: "completed" }));
    await runs.create(makeRun(schedule.scheduleId, { status: "failed" }));
    await runs.create(makeRun(schedule.scheduleId, { status: "skipped" }));
    await runs.create(makeRun(schedule.scheduleId, { status: "cancelled" }));
    const unfinished = await runs.listUnfinished(schedule.scheduleId);
    expect(unfinished.map((row) => row.status).sort()).toEqual(["pending", "running"]);
  });

  it("prunes run history to the retention bound", async () => {
    const schedule = makeTask();
    await tasks.upsert(schedule);
    for (let i = 0; i < 5; i++) {
      await runs.create(
        makeRun(schedule.scheduleId, { status: "completed", scheduledFor: Date.now() + i }),
      );
    }
    expect(await runs.pruneRuns(schedule.scheduleId, 2)).toBe(3);
    expect((await runs.listBySchedule(schedule.scheduleId, 100)).length).toBe(2);
  });

  it("remove deletes the definition but preserves run history", async () => {
    const schedule = makeTask();
    await tasks.upsert(schedule);
    await runs.create(makeRun(schedule.scheduleId, { status: "completed" }));
    expect(await tasks.remove(schedule.scheduleId)).toBe(true);
    expect(await tasks.get(schedule.scheduleId)).toBeNull();
    expect(await tasks.remove(schedule.scheduleId)).toBe(false);
    expect((await runs.listBySchedule(schedule.scheduleId, 100)).length).toBe(1);
  });

  it("rejects empty ids", async () => {
    await expect(tasks.get("")).rejects.toBeInstanceOf(ScheduledTaskValidationError);
    await expect(tasks.listByProject("")).rejects.toBeInstanceOf(ScheduledTaskValidationError);
    await expect(runs.get("")).rejects.toBeInstanceOf(ScheduledTaskValidationError);
  });

  it("refuses secret material before persistence", async () => {
    await expect(
      tasks.upsert(makeTask({ prompt: "use api_key=sk-live-12345 now" })),
    ).rejects.toBeInstanceOf(ScheduledTaskSecretError);
    const schedule = makeTask();
    await tasks.upsert(schedule);
    await expect(
      runs.create(makeRun(schedule.scheduleId, { error: "password=hunter2 failed" })),
    ).rejects.toBeInstanceOf(ScheduledTaskSecretError);
  });
});
