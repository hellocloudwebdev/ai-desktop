// PR37: apps/desktop — DocumentsToolExecutor Tests
//
// Covers tool registration (4 tools), validate-before-permission ordering,
// deny path (isError), delete risk=high recording, and unknown-tool errors.
// DocumentService is faked in-memory; PermissionManager is allow/deny fakes.

import { describe, expect, it } from "vitest";
import {
  createDocumentId,
  DOCUMENT_TOOL_IDS,
  type PermissionCheck,
  type PermissionDecisionResult,
} from "@ai-desktop/ai-core";
import type { PermissionManager } from "@ai-desktop/permissions";
import { ValidationError } from "@ai-desktop/shared";
import { DocumentService } from "../document-service.js";
import { DocumentsToolExecutor } from "../documents-tool-executor.js";
import type {
  DocumentRepository,
  StoredDocument,
  StoredDocumentChunk,
  CreateDocumentData,
  CreateDocumentChunkData,
  UpdateDocumentStatusData,
} from "@ai-desktop/storage";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class AllowAllPermissions implements PermissionManager {
  readonly checks: Array<{
    capability: string;
    action: string;
    resource: string;
    risk: string;
  }> = [];

  async check(request: PermissionCheck): Promise<PermissionDecisionResult> {
    this.checks.push({
      capability: request.capability,
      action: request.action,
      resource: request.resource,
      risk: request.risk,
    });
    return { kind: "allow" };
  }

  async resolve(): Promise<boolean> {
    return true;
  }
  async revoke(): Promise<number> {
    return 0;
  }
  getPendingRequest(): undefined {
    return undefined;
  }
  listPendingRequests(): readonly [] {
    return [];
  }
  async listActivePolicies(): Promise<readonly []> {
    return [];
  }
}

class DenyAllPermissions extends AllowAllPermissions {
  override async check(): Promise<PermissionDecisionResult> {
    return { kind: "deny", reason: "test denial" };
  }
}

class FakeDocumentRepository implements DocumentRepository {
  async createDocument(data: CreateDocumentData): Promise<StoredDocument> {
    throw new Error(`not needed: ${data.documentId}`);
  }
  async getDocumentById(documentId: string): Promise<StoredDocument | null> {
    void documentId;
    return null;
  }
  async listDocumentsByProject(projectId: string, statuses?: string[]): Promise<StoredDocument[]> {
    void projectId;
    void statuses;
    return [];
  }
  async updateDocumentStatus(
    documentId: string,
    data: UpdateDocumentStatusData,
  ): Promise<StoredDocument> {
    void documentId;
    void data;
    throw new Error("not needed");
  }
  async deleteDocument(documentId: string, projectId: string): Promise<void> {
    void documentId;
    void projectId;
  }
  async createChunks(chunks: CreateDocumentChunkData[]): Promise<StoredDocumentChunk[]> {
    return chunks.map((c) => ({ ...c, locatorPage: c.locatorPage ?? null }));
  }
  async listChunksByDocument(
    documentId: string,
    projectId: string,
  ): Promise<StoredDocumentChunk[]> {
    void documentId;
    void projectId;
    return [];
  }
  async deleteChunksByDocument(documentId: string, projectId: string): Promise<number> {
    void documentId;
    void projectId;
    return 0;
  }
}

function makeExecutor(permissions?: AllowAllPermissions): {
  executor: DocumentsToolExecutor;
  permissions: AllowAllPermissions;
} {
  const perms = permissions ?? new AllowAllPermissions();
  const service = new DocumentService({ repository: new FakeDocumentRepository() });
  return {
    executor: new DocumentsToolExecutor({ permissionManager: perms, documentService: service }),
    permissions: perms,
  };
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeSeededRepository(): FakeDocumentRepository {
  const repo = new FakeDocumentRepository();
  const docs = new Map<string, StoredDocument>();
  const chunks = new Map<string, StoredDocumentChunk[]>();
  repo.createDocument = async (data: CreateDocumentData) => {
    const stored: StoredDocument = {
      ...data,
      title: null,
      author: null,
      pageCount: null,
      language: null,
      errorCode: null,
      errorMessage: null,
    };
    docs.set(data.documentId, stored);
    return stored;
  };
  repo.updateDocumentStatus = async (documentId: string, data: UpdateDocumentStatusData) => {
    const existing = docs.get(documentId);
    if (!existing) {
      throw new Error(`Document "${documentId}" not found`);
    }
    const updated: StoredDocument = { ...existing, status: data.status, updatedAt: Date.now() };
    docs.set(documentId, updated);
    return updated;
  };
  repo.deleteDocument = async (documentId: string, projectId: string) => {
    docs.delete(documentId);
    chunks.delete(`${projectId}:${documentId}`);
  };
  repo.listDocumentsByProject = async (projectId: string, statuses?: string[]) =>
    [...docs.values()].filter(
      (d) => d.projectId === projectId && (!statuses?.length || statuses.includes(d.status)),
    );
  repo.getDocumentById = async (id: string) => docs.get(id) ?? null;
  repo.createChunks = async (items: CreateDocumentChunkData[]) => {
    const stored = items.map((item) => ({ ...item, locatorPage: item.locatorPage ?? null }));
    for (const chunk of stored) {
      const key = `${chunk.projectId}:${chunk.documentId}`;
      const list = chunks.get(key) ?? [];
      list.push(chunk);
      list.sort((a, b) => a.ordinal - b.ordinal);
      chunks.set(key, list);
    }
    return stored;
  };
  repo.listChunksByDocument = async (id: string, projectId: string) =>
    (chunks.get(`${projectId}:${id}`) ?? []).map((c) => ({ ...c }));
  repo.deleteChunksByDocument = async (id: string, projectId: string) => {
    const count = chunks.get(`${projectId}:${id}`)?.length ?? 0;
    chunks.delete(`${projectId}:${id}`);
    return count;
  };
  return repo;
}

async function seedExecutor(): Promise<DocumentsToolExecutor> {
  const service = new DocumentService({ repository: makeSeededRepository() });
  await service.ingest({
    projectId: "p1",
    fileName: "seed.txt",
    mimeType: "text/plain",
    bytes: enc("Seeded content about harbor lighthouses guiding ships."),
  });
  return new DocumentsToolExecutor({
    permissionManager: new AllowAllPermissions(),
    documentService: service,
  });
}

describe("DocumentsToolExecutor registration", () => {
  it("registers exactly the 4 canonical document tools", () => {
    const { executor } = makeExecutor();
    expect(executor.listTools()).toHaveLength(4);
    for (const toolId of DOCUMENT_TOOL_IDS) {
      expect(executor.hasTool(toolId)).toBe(true);
      expect(executor.resolve(toolId)?.name).toBe(toolId);
    }
  });

  it("reports false for unknown tools", () => {
    const { executor } = makeExecutor();
    expect(executor.hasTool("builtin:documents.unknown")).toBe(false);
    expect(executor.resolve("builtin:research.search")).toBeUndefined();
  });
});

describe("DocumentsToolExecutor lifecycle", () => {
  it("validates input before the permission check", async () => {
    const { executor, permissions } = makeExecutor();
    await expect(executor.execute("builtin:documents.search", { projectId: "p1" })).rejects.toThrow(
      ValidationError,
    );
    expect(permissions.checks).toHaveLength(0);
  });

  it("returns isError on permission denial without dispatching", async () => {
    const deny = new DenyAllPermissions();
    const service = new DocumentService({ repository: new FakeDocumentRepository() });
    const executor = new DocumentsToolExecutor({
      permissionManager: deny,
      documentService: service,
    });
    const result = await executor.execute("builtin:documents.list", { projectId: "p1" });
    expect(result.isError).toBe(true);
    expect(String(result.result)).toContain("Permission denied");
    expect(result.metadata?.["permissionStatus"]).toBe("deny");
  });

  it("checks capability documents with low risk for list/search/open", async () => {
    const executor = await seedExecutor();
    const docs = await executor.execute("builtin:documents.list", { projectId: "p1" });
    expect(docs.isError).toBe(false);

    const search = await executor.execute("builtin:documents.search", {
      projectId: "p1",
      query: "lighthouses",
    });
    expect(search.isError).toBe(false);
    expect(String(search.result)).toContain("lighthouses");
  });

  it("records high risk for the delete tool", async () => {
    const permissions = new AllowAllPermissions();
    const { executor } = makeExecutor(permissions);
    const result = await executor.execute("builtin:documents.delete", {
      projectId: "p1",
      documentId: createDocumentId(),
    });
    expect(result.isError).toBe(false);
    const deleteCheck = permissions.checks.find((c) => c.action === "delete");
    expect(deleteCheck?.capability).toBe("documents");
    expect(deleteCheck?.risk).toBe("high");
  });

  it("executes open and serializes bounded results", async () => {
    const executor = await seedExecutor();
    const listed = JSON.parse(
      String((await executor.execute("builtin:documents.list", { projectId: "p1" })).result),
    ) as Array<{ documentId: string }>;
    expect(listed).toHaveLength(1);
    const opened = await executor.execute("builtin:documents.open", {
      projectId: "p1",
      documentId: listed[0]?.documentId,
    });
    expect(opened.isError).toBe(false);
    expect(String(opened.result)).toContain("harbor lighthouses");
  });

  it("returns isError for service failures (open missing)", async () => {
    const { executor } = makeExecutor();
    const result = await executor.execute("builtin:documents.open", {
      projectId: "p1",
      documentId: createDocumentId(),
    });
    expect(result.isError).toBe(true);
    expect(String(result.result)).toMatch(/NOT_FOUND/);
  });

  it("builds project-scoped resource strings", async () => {
    const permissions = new AllowAllPermissions();
    const { executor } = makeExecutor(permissions);
    await executor.execute("builtin:documents.search", { projectId: "proj-x", query: "hello" });
    const check = permissions.checks[0];
    expect(check?.resource).toContain("proj-x");
    expect(check?.resource).toContain("hello");
  });

  it("throws for unknown tool names", async () => {
    const { executor } = makeExecutor();
    await expect(executor.execute("builtin:documents.nope", {})).rejects.toThrow(ValidationError);
    await expect(executor.execute("builtin:research.search", {})).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for invalid delete input before permission", async () => {
    const { executor, permissions } = makeExecutor();
    await expect(executor.execute("builtin:documents.delete", { projectId: "p1" })).rejects.toThrow(
      ValidationError,
    );
    expect(permissions.checks).toHaveLength(0);
  });

  it("delete round-trips through the service", async () => {
    const executor = await seedExecutor();
    const listed = JSON.parse(
      String((await executor.execute("builtin:documents.list", { projectId: "p1" })).result),
    ) as Array<{ documentId: string }>;
    const deleted = await executor.execute("builtin:documents.delete", {
      projectId: "p1",
      documentId: listed[0]?.documentId,
    });
    expect(deleted.isError).toBe(false);
    const relisted = JSON.parse(
      String((await executor.execute("builtin:documents.list", { projectId: "p1" })).result),
    ) as unknown[];
    expect(relisted).toHaveLength(0);
  });
});
