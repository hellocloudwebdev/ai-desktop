-- CreateTable
CREATE TABLE IF NOT EXISTS "extension_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "manifest" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL,
    "trust" TEXT NOT NULL,
    "installPath" TEXT,
    "installedAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "extension_project_bindings" (
    "extensionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    PRIMARY KEY ("extensionId", "projectId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "extension_project_bindings_projectId_idx" ON "extension_project_bindings"("projectId");
