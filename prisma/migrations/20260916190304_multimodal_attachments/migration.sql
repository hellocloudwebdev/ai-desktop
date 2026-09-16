-- CreateTable
CREATE TABLE IF NOT EXISTS "attachments" (
    "attachmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    PRIMARY KEY ("attachmentId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "attachments_projectId_idx" ON "attachments"("projectId");
