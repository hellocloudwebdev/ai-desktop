-- CreateTable
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "background_tasks_projectId_idx" ON "background_tasks"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "background_tasks_status_idx" ON "background_tasks"("status");
