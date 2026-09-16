-- CreateTable
CREATE TABLE IF NOT EXISTS "documents" (
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
CREATE TABLE IF NOT EXISTS "document_chunks" (
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
CREATE INDEX IF NOT EXISTS "documents_projectId_idx" ON "documents"("projectId");
CREATE INDEX IF NOT EXISTS "documents_projectId_status_idx" ON "documents"("projectId", "status");
CREATE INDEX IF NOT EXISTS "document_chunks_projectId_idx" ON "document_chunks"("projectId");
CREATE INDEX IF NOT EXISTS "document_chunks_documentId_idx" ON "document_chunks"("documentId");
CREATE INDEX IF NOT EXISTS "document_chunks_projectId_documentId_idx" ON "document_chunks"("projectId", "documentId");
