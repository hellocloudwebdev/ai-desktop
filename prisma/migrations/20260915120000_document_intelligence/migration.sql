-- CreateTable
CREATE TABLE IF NOT EXISTS "DocumentRecord" (
    "documentId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "sourceFileSize" INTEGER NOT NULL,
    "title" TEXT,
    "author" TEXT,
    "pageCount" INTEGER,
    "language" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DocumentChunkRecord" (
    "chunkId" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "locatorKind" TEXT NOT NULL,
    "locatorValue" TEXT NOT NULL,
    "locatorPage" INTEGER,
    "checksumSha256" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DocumentRecord_projectId_idx" ON "DocumentRecord"("projectId");
CREATE INDEX IF NOT EXISTS "DocumentRecord_projectId_status_idx" ON "DocumentRecord"("projectId", "status");
CREATE INDEX IF NOT EXISTS "DocumentChunkRecord_projectId_idx" ON "DocumentChunkRecord"("projectId");
CREATE INDEX IF NOT EXISTS "DocumentChunkRecord_documentId_idx" ON "DocumentChunkRecord"("documentId");
CREATE INDEX IF NOT EXISTS "DocumentChunkRecord_projectId_documentId_idx" ON "DocumentChunkRecord"("projectId", "documentId");
