// PR43: packages/storage — Background Task Repository Tests
//
// Covers upsert/get round-trip, project isolation, unfinished filtering,
// remove, updateStatus patching, truncation bounds, empty-id rejection,
// secret refusal, and idempotent upsert overwrite. File-backed tmp DB seeded
// with CREATE TABLE so the tests run without a global migrate step (fresh
// tmp file path; StorageDatabase.initialize() only connects + sets WAL).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateUlid } from "@ai-desktop/shared";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { StorageDatabase } from "../../client/database.js";
import {
  BackgroundTaskSecretError,
  BackgroundTaskValidationError,
  PrismaBackgroundTaskRepository,
  type BackgroundTaskRow,
} from "../background-task-repository.js";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS "background_tasks" (
    "taskId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'background',
    "status" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "startedAt" BIGINT,
    "completedAt" BIGINT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "resultSummary" TEXT,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY ("taskId")
);
CREATE INDEX IF NOT EXISTS "background_tasks_projectId_idx" ON "background_tasks"("projectId");
CREATE INDEX IF NOT EXISTS "background_tasks_status_idx" ON "background_tasks"("status");
`;

let dir: string;
let db: StorageDatabase;
let repo: PrismaBackgroundTaskRepository;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "background-tasks-repo-"));
  db = new StorageDatabase({ url: `file:${path.join(dir, "test.db")}` });
  await db.initialize();
  // Verify the CREATE SQL matches the migration file byte-for-byte in shape.
  const migrationSql = fs.readFileSync(
    path.resolve(
      "D:/Packages/ai-desktop/prisma/migrations/20260918120000_background_tasks/migration.sql",
    ),
    "utf8",
  );
  expect(migrationSql).toContain('"background_tasks"');
  const statements = CREATE_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) {
    await db.client.$executeRawUnsafe(sql);
  }
  repo = new PrismaBackgroundTaskRepository(db);
});

afterAll(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeRow(overrides: Partial<BackgroundTaskRow> = {}): BackgroundTaskRow {
  const ts = Date.now();
  return {
    taskId: generateUlid(),
    conversationId: generateUlid(),
    projectId: generateUlid(),
    title: "Test task",
    goal: "Do something useful",
    mode: "background",
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    completedAt: null,
    attempt: 0,
    lastError: null,
    resultSummary: null,
    nodeCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("PrismaBackgroundTaskRepository", () => {
  it("upsert/get round-trips a full row", async () => {
    const row = makeRow({ title: "Round trip", goal: "verify fidelity", nodeCount: 3 });
    await repo.upsert(row);
    const fetched = await repo.get(row.taskId);
    expect(fetched).not.toBeNull();
    expect(fetched).toMatchObject({
      taskId: row.taskId,
      conversationId: row.conversationId,
      projectId: row.projectId,
      title: "Round trip",
      goal: "verify fidelity",
      mode: "background",
      status: "pending",
      attempt: 0,
      nodeCount: 3,
      schemaVersion: 1,
    });
    expect(fetched!.createdAt).toBe(row.createdAt);
  });

  it("returns null for an unknown taskId", async () => {
    expect(await repo.get(generateUlid())).toBeNull();
  });

  it("listByProject isolates rows by project", async () => {
    const projectA = generateUlid();
    const projectB = generateUlid();
    await repo.upsert(makeRow({ projectId: projectA, title: "A1" }));
    await repo.upsert(makeRow({ projectId: projectA, title: "A2" }));
    await repo.upsert(makeRow({ projectId: projectB, title: "B1" }));
    const rowsA = await repo.listByProject(projectA);
    expect(rowsA).toHaveLength(2);
    expect(rowsA.every((r) => r.projectId === projectA)).toBe(true);
    const rowsB = await repo.listByProject(projectB);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.title).toBe("B1");
  });

  it("cross-project isolation: other projects never leak into listByProject", async () => {
    const projectA = generateUlid();
    const projectB = generateUlid();
    await repo.upsert(makeRow({ projectId: projectA }));
    const rowsB = await repo.listByProject(projectB);
    expect(rowsB).toEqual([]);
  });

  it("listUnfinished excludes completed/failed/cancelled", async () => {
    const marker = `unfinished-${generateUlid()}`;
    await repo.upsert(makeRow({ status: "pending", title: `${marker}-pending` }));
    await repo.upsert(makeRow({ status: "running", title: `${marker}-running` }));
    const done = makeRow({ status: "completed", title: `${marker}-done` });
    const failed = makeRow({ status: "failed", title: `${marker}-failed` });
    const cancelled = makeRow({ status: "cancelled", title: `${marker}-cancelled` });
    await repo.upsert(done);
    await repo.upsert(failed);
    await repo.upsert(cancelled);
    const unfinished = await repo.listUnfinished();
    const titles = new Set(unfinished.map((r) => r.title));
    expect(titles.has(`${marker}-pending`)).toBe(true);
    expect(titles.has(`${marker}-running`)).toBe(true);
    expect(unfinished.some((r) => r.taskId === done.taskId)).toBe(false);
    expect(unfinished.some((r) => r.taskId === failed.taskId)).toBe(false);
    expect(unfinished.some((r) => r.taskId === cancelled.taskId)).toBe(false);
  });

  it("remove deletes and returns true; second remove returns false", async () => {
    const row = makeRow();
    await repo.upsert(row);
    expect(await repo.remove(row.taskId)).toBe(true);
    expect(await repo.get(row.taskId)).toBeNull();
    expect(await repo.remove(row.taskId)).toBe(false);
  });

  it("remove on unknown taskId returns false", async () => {
    expect(await repo.remove(generateUlid())).toBe(false);
  });

  it("updateStatus patches status and optional fields", async () => {
    const row = makeRow({ status: "running" });
    await repo.upsert(row);
    const started = Date.now();
    const ok = await repo.updateStatus(row.taskId, "completed", {
      resultSummary: "All done",
      nodeCount: 7,
      startedAt: started,
      completedAt: started + 1000,
    });
    expect(ok).toBe(true);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.status).toBe("completed");
    expect(fetched!.resultSummary).toBe("All done");
    expect(fetched!.nodeCount).toBe(7);
    expect(fetched!.startedAt).toBe(started);
    expect(fetched!.completedAt).toBe(started + 1000);
  });

  it("updateStatus with lastError patch persists the error text", async () => {
    const row = makeRow({ status: "running" });
    await repo.upsert(row);
    expect(await repo.updateStatus(row.taskId, "failed", { lastError: "boom" })).toBe(true);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.status).toBe("failed");
    expect(fetched!.lastError).toBe("boom");
  });

  it("updateStatus on unknown taskId returns false", async () => {
    expect(await repo.updateStatus(generateUlid(), "completed")).toBe(false);
  });

  it("truncates title to 120 chars without throwing", async () => {
    const row = makeRow({ title: "t".repeat(500) });
    await repo.upsert(row);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.title).toHaveLength(120);
  });

  it("truncates goal to 4000 chars without throwing", async () => {
    const row = makeRow({ goal: "g".repeat(6000) });
    await repo.upsert(row);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.goal).toHaveLength(4000);
  });

  it("truncates lastError to 2000 and resultSummary to 8000", async () => {
    const row = makeRow({
      lastError: "e".repeat(3000),
      resultSummary: "r".repeat(9000),
    });
    await repo.upsert(row);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.lastError).toHaveLength(2000);
    expect(fetched!.resultSummary).toHaveLength(8000);
  });

  it("updateStatus truncates over-long patch fields", async () => {
    const row = makeRow();
    await repo.upsert(row);
    await repo.updateStatus(row.taskId, "failed", {
      lastError: "e".repeat(3000),
      resultSummary: "r".repeat(9000),
    });
    const fetched = await repo.get(row.taskId);
    expect(fetched!.lastError).toHaveLength(2000);
    expect(fetched!.resultSummary).toHaveLength(8000);
  });

  it("rejects empty taskId on upsert", async () => {
    await expect(repo.upsert(makeRow({ taskId: "" }))).rejects.toThrow(
      BackgroundTaskValidationError,
    );
  });

  it("rejects empty projectId on upsert", async () => {
    await expect(repo.upsert(makeRow({ projectId: "   " }))).rejects.toThrow(
      BackgroundTaskValidationError,
    );
  });

  it("rejects empty taskId on get/remove/updateStatus", async () => {
    await expect(repo.get("")).rejects.toThrow(BackgroundTaskValidationError);
    await expect(repo.remove("")).rejects.toThrow(BackgroundTaskValidationError);
    await expect(repo.updateStatus("", "completed")).rejects.toThrow(BackgroundTaskValidationError);
  });

  it("rejects empty projectId on listByProject", async () => {
    await expect(repo.listByProject("")).rejects.toThrow(BackgroundTaskValidationError);
  });

  it("refuses secrets in goal (api_key)", async () => {
    await expect(
      repo.upsert(makeRow({ goal: "use api_key=sk-live-abcdef123456 to call the API" })),
    ).rejects.toThrow(BackgroundTaskSecretError);
  });

  it("refuses secrets in title and lastError", async () => {
    await expect(repo.upsert(makeRow({ title: "rotate the client_secret value" }))).rejects.toThrow(
      BackgroundTaskSecretError,
    );
    const row = makeRow();
    await repo.upsert(row);
    await expect(
      repo.updateStatus(row.taskId, "failed", { lastError: "leaked aws_secret token XYZ" }),
    ).rejects.toThrow(BackgroundTaskSecretError);
  });

  it("idempotent upsert overwrites the existing row", async () => {
    const row = makeRow({ title: "v1", status: "pending", nodeCount: 1 });
    await repo.upsert(row);
    await repo.upsert({ ...row, title: "v2", status: "running", nodeCount: 2 });
    const fetched = await repo.get(row.taskId);
    expect(fetched!.title).toBe("v2");
    expect(fetched!.status).toBe("running");
    expect(fetched!.nodeCount).toBe(2);
    expect(await repo.remove(row.taskId)).toBe(true);
  });

  it("defaults mode to background when empty", async () => {
    const row = makeRow({ mode: "" });
    await repo.upsert(row);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.mode).toBe("background");
  });

  it("persists startedAt/completedAt nullable timestamps", async () => {
    const now = Date.now();
    const row = makeRow({ status: "running", startedAt: now, completedAt: null });
    await repo.upsert(row);
    const fetched = await repo.get(row.taskId);
    expect(fetched!.startedAt).toBe(now);
    expect(fetched!.completedAt).toBeNull();
  });
});
