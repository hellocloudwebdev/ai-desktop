import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StorageDatabase } from "../client/database.js";
import { PrismaPermissionRepository } from "../permissions/prisma-permission-repository.js";
import { generateUlid } from "@ai-desktop/shared";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

describe("packages/storage: PrismaPermissionRepository (PR24)", () => {
  let tmpDbPath: string;
  let db: StorageDatabase;
  let repo: PrismaPermissionRepository;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-storage-permissions-"));
    tmpDbPath = path.join(tmpDir, "test.db");

    const templateDb = path.resolve("D:/Packages/ai-desktop/prisma/dev.db");
    if (fs.existsSync(templateDb)) {
      fs.copyFileSync(templateDb, tmpDbPath);
    }

    db = new StorageDatabase({
      url: `file:${tmpDbPath.replace(/\\/g, "/")}`,
    });
    await db.initialize();
    repo = new PrismaPermissionRepository(db);
  });

  afterAll(async () => {
    await db.close();
    try {
      const dir = path.dirname(tmpDbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  });

  it("saves and retrieves a project permission policy", async () => {
    const policyId = generateUlid();
    const projectId = "proj-alpha";
    const ts = Date.now();

    const saved = await repo.savePolicy({
      id: policyId,
      projectId,
      capability: "filesystem",
      action: "read",
      resourcePattern: "/workspace/src",
      decision: "allow",
      scope: "project",
      createdAt: ts,
      updatedAt: ts,
    });

    expect(saved.id).toBe(policyId);
    expect(saved.projectId).toBe(projectId);
    expect(saved.capability).toBe("filesystem");
    expect(saved.decision).toBe("allow");

    const fetched = await repo.getPolicyById(policyId);
    expect(fetched).toEqual(saved);
  });

  it("finds policies filtered by projectId and capability", async () => {
    const p1 = generateUlid();
    const p2 = generateUlid();
    const ts = Date.now();

    await repo.savePolicy({
      id: p1,
      projectId: "proj-beta",
      capability: "execution",
      action: "execute",
      resourcePattern: "npm test",
      decision: "allow",
      scope: "project",
      createdAt: ts,
      updatedAt: ts,
    });

    await repo.savePolicy({
      id: p2,
      projectId: "proj-gamma",
      capability: "execution",
      action: "execute",
      resourcePattern: "npm run build",
      decision: "allow",
      scope: "project",
      createdAt: ts + 1,
      updatedAt: ts + 1,
    });

    const betaPolicies = await repo.findPolicies({ projectId: "proj-beta" });
    expect(betaPolicies.some((p) => p.id === p1)).toBe(true);
    expect(betaPolicies.some((p) => p.id === p2)).toBe(false);
  });

  it("deletes policy by id and by criteria idempotently", async () => {
    const policyId = generateUlid();
    const ts = Date.now();

    await repo.savePolicy({
      id: policyId,
      projectId: "proj-delta",
      capability: "mcp",
      resourcePattern: "github/create_issue",
      decision: "allow",
      scope: "project",
      createdAt: ts,
      updatedAt: ts,
    });

    const deletedCount = await repo.deletePoliciesByCriteria({
      capability: "mcp",
      projectId: "proj-delta",
    });
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const fetched = await repo.getPolicyById(policyId);
    expect(fetched).toBeNull();

    // Idempotent delete on nonexistent id
    await expect(repo.deletePolicy(generateUlid())).resolves.toBeUndefined();
  });

  it("records immutable permission audit entries and queries them in order", async () => {
    const auditId = generateUlid();
    const ts = Date.now();
    const toolCallId = generateUlid();

    const recorded = await repo.recordAudit({
      id: auditId,
      projectId: "proj-audit",
      conversationId: "conv-123",
      permissionRequestId: generateUlid(),
      capability: "secrets.use",
      action: "use",
      resource: "app/provider/gemini/api-key",
      scope: "project",
      risk: "high",
      decision: "allow",
      decidedBy: "user",
      relatedToolCallIds: [toolCallId],
      reason: "User explicitly approved API key access",
      timestamp: ts,
    });

    expect(recorded.id).toBe(auditId);
    expect(recorded.capability).toBe("secrets.use");
    expect(recorded.relatedToolCallIds).toEqual([toolCallId]);

    const history = await repo.getAuditHistory({ projectId: "proj-audit" });
    expect(history.length).toBeGreaterThanOrEqual(1);
    const entry = history.find((h) => h.id === auditId);
    expect(entry).toBeDefined();
    expect(entry?.decision).toBe("allow");
  });
});
