-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "taskId" TEXT,
    "sequence" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "events_conversationId_idx" ON "events"("conversationId");

-- CreateIndex
CREATE INDEX "events_taskId_idx" ON "events"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "events_conversationId_sequence_key" ON "events"("conversationId", "sequence");
