-- CreateTable
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_tasks_projectId_idx" ON "scheduled_tasks"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_tasks_enabled_idx" ON "scheduled_tasks"("enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_tasks_enabled_nextRunAt_idx" ON "scheduled_tasks"("enabled", "nextRunAt");

-- CreateTable
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_runs_scheduleId_idx" ON "scheduled_runs"("scheduleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_runs_projectId_idx" ON "scheduled_runs"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_runs_status_idx" ON "scheduled_runs"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scheduled_runs_scheduleId_scheduledFor_idx" ON "scheduled_runs"("scheduleId", "scheduledFor");
