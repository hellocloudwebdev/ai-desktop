-- CreateTable
CREATE TABLE IF NOT EXISTS "accounts" (
    "accountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "devices" (
    "deviceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceName" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "lastSeenAt" BIGINT NOT NULL,
    PRIMARY KEY ("deviceId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "devices_accountId_idx" ON "devices"("accountId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "sync_records" (
    "recordId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "deletedAt" BIGINT,
    PRIMARY KEY ("recordId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sync_records_entityType_idx" ON "sync_records"("entityType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sync_records_accountId_idx" ON "sync_records"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sync_records_entityType_entityId_idx" ON "sync_records"("entityType", "entityId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "sync_cursors" (
    "key" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sync_conflicts" (
    "conflictId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "localVersion" INTEGER NOT NULL,
    "remoteVersion" INTEGER NOT NULL,
    "changedFieldsJson" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    PRIMARY KEY ("conflictId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sync_conflicts_accountId_idx" ON "sync_conflicts"("accountId");
