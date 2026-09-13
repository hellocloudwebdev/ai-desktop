// PR32: apps/desktop — ExtensionService Tests (desktop wiring)
//
// Covers the desktop-owned ExtensionService over in-memory storage doubles:
// install fixture -> enable -> tool in registry with plugin: id -> executor
// allow path executes via registered handler (stub PermissionManager allow);
// deny path invokes no backend; disable removes tools with history untouched;
// project A enabled resolves, project B blocked; restart over the same
// StorageDatabase restores installation + binding + hash.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createToolCallId } from "@ai-desktop/shared";
import type {
  PermissionDecisionResult,
  PermissionManager,
  PermissionRequest,
} from "@ai-desktop/ai-core";
import type { PermissionPolicy } from "@ai-desktop/permissions";
import {
  PrismaExtensionProjectBindingRepository,
  PrismaExtensionRepository,
  StorageDatabase,
  type ExtensionProjectBindingRepository,
  type ExtensionRepository,
  type StoredExtension,
  type CreateExtensionData,
  type StoredExtensionProjectBinding,
} from "@ai-desktop/storage";
import { ExtensionService, PluginToolRegistry } from "../main/extensions/index.js";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "test-extension");

class StubPermissionManager implements PermissionManager {
  public checks = 0;
  constructor(private readonly _decision: PermissionDecisionResult) {}

  async check(): Promise<PermissionDecisionResult> {
    this.checks += 1;
    return this._decision;
  }

  async resolve(): Promise<boolean> {
    return false;
  }

  async revoke(): Promise<number> {
    return 0;
  }

  getPendingRequest(): PermissionRequest | undefined {
    return undefined;
  }

  listPendingRequests(): readonly PermissionRequest[] {
    return [];
  }

  async listActivePolicies(): Promise<readonly PermissionPolicy[]> {
    return [];
  }

  async checkApproval(): Promise<boolean> {
    return false;
  }
}

class InMemoryExtensionRepository implements ExtensionRepository {
  private readonly _store = new Map<string, StoredExtension>();

  async saveExtension(data: CreateExtensionData): Promise<StoredExtension> {
    const existing = this._store.get(data.id);
    const stored: StoredExtension = {
      id: data.id,
      name: data.name,
      version: data.version,
      displayName: data.displayName ?? null,
      description: data.description ?? null,
      manifest: data.manifest,
      manifestHash: data.manifestHash,
      lifecycle: data.lifecycle,
      trust: data.trust,
      installPath: data.installPath ?? null,
      installedAt: existing?.installedAt ?? data.installedAt,
      updatedAt: data.updatedAt,
    };
    this._store.set(data.id, stored);
    return stored;
  }

  async getExtension(id: string): Promise<StoredExtension | null> {
    return this._store.get(id) ?? null;
  }

  async listExtensions(): Promise<StoredExtension[]> {
    return [...this._store.values()];
  }

  async setLifecycle(id: string, lifecycle: string): Promise<StoredExtension> {
    const cur = this._store.get(id);
    if (!cur) throw new Error(`Extension "${id}" not found`);
    const updated: StoredExtension = { ...cur, lifecycle, updatedAt: Date.now() };
    this._store.set(id, updated);
    return updated;
  }

  async setTrust(id: string, trust: string): Promise<StoredExtension> {
    const cur = this._store.get(id);
    if (!cur) throw new Error(`Extension "${id}" not found`);
    const updated: StoredExtension = { ...cur, trust, updatedAt: Date.now() };
    this._store.set(id, updated);
    return updated;
  }

  async updateHash(id: string, manifestHash: string): Promise<StoredExtension> {
    const cur = this._store.get(id);
    if (!cur) throw new Error(`Extension "${id}" not found`);
    const updated: StoredExtension = { ...cur, manifestHash, updatedAt: Date.now() };
    this._store.set(id, updated);
    return updated;
  }

  async deleteExtension(id: string): Promise<void> {
    this._store.delete(id);
  }
}

class InMemoryBindingRepository implements ExtensionProjectBindingRepository {
  private readonly _bindings = new Map<string, StoredExtensionProjectBinding>();

  async setBinding(
    extensionId: string,
    projectId: string,
    enabled: boolean,
  ): Promise<StoredExtensionProjectBinding> {
    const ts = Date.now();
    const existing = this._bindings.get(`${extensionId}:${projectId}`);
    const stored: StoredExtensionProjectBinding = {
      extensionId,
      projectId,
      enabled,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this._bindings.set(`${extensionId}:${projectId}`, stored);
    return stored;
  }

  async getBinding(
    extensionId: string,
    projectId: string,
  ): Promise<StoredExtensionProjectBinding | null> {
    return this._bindings.get(`${extensionId}:${projectId}`) ?? null;
  }

  async listBindingsForExtension(extensionId: string): Promise<StoredExtensionProjectBinding[]> {
    return [...this._bindings.values()].filter((b) => b.extensionId === extensionId);
  }

  async listBindingsForProject(projectId: string): Promise<StoredExtensionProjectBinding[]> {
    return [...this._bindings.values()].filter((b) => b.projectId === projectId);
  }

  async deleteBindingsForExtension(extensionId: string): Promise<void> {
    for (const key of [...this._bindings.keys()]) {
      if (key.startsWith(`${extensionId}:`)) {
        this._bindings.delete(key);
      }
    }
  }
}

function createService(options?: {
  permission?: PermissionManager;
  installBaseDir?: string;
  repository?: ExtensionRepository;
  bindings?: ExtensionProjectBindingRepository;
  toolRegistry?: PluginToolRegistry;
}): {
  service: ExtensionService;
  permission: StubPermissionManager;
  repository: ExtensionRepository;
  bindings: ExtensionProjectBindingRepository;
  toolRegistry: PluginToolRegistry;
} {
  const tmpBase =
    options?.installBaseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ext-"));
  const permission =
    (options?.permission as StubPermissionManager | undefined) ??
    new StubPermissionManager({ kind: "allow" });
  const repository = options?.repository ?? new InMemoryExtensionRepository();
  const bindings = options?.bindings ?? new InMemoryBindingRepository();
  const toolRegistry = options?.toolRegistry ?? new PluginToolRegistry();
  const service = new ExtensionService({
    repository,
    bindingRepository: bindings,
    permissionManager: permission,
    installBaseDir: path.join(tmpBase, "installed"),
    toolRegistry,
  });
  return { service, permission, repository, bindings, toolRegistry };
}

function createTempDbPath(prefix: string): { tmpDbPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tmpDbPath = path.join(tmpDir, "test.db");
  // Template dev.db (created by prisma migrate dev) preserves the schema.
  // Resolved relative to the repo root so the test is portable across machines.
  const templateDb = path.resolve(__dirname, "../../../../prisma/dev.db");
  if (fs.existsSync(templateDb)) {
    fs.copyFileSync(templateDb, tmpDbPath);
  }
  return {
    tmpDbPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe("apps/desktop: ExtensionService (PR32)", () => {
  it("installs the fixture, auto-trusts untrusted, and enables with plugin: tool registration", async () => {
    const installBase = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ext-install-"));
    const { service, toolRegistry } = createService({ installBaseDir: installBase });
    try {
      const info = await service.installExtension(FIXTURE_DIR);
      expect(info.id).toBe("test-extension");
      expect(info.lifecycle).toBe("installed");
      expect(info.trust).toBe("untrusted");
      expect(info.manifestHash).toMatch(/^[0-9a-f]{64}$/);

      // No tools registered before enable.
      expect(toolRegistry.hasTool("plugin:test-extension/echo")).toBe(false);

      const enabled = await service.enableExtension("test-extension");
      expect(enabled.lifecycle).toBe("active");
      expect(toolRegistry.hasTool("plugin:test-extension/echo")).toBe(true);
      const def = toolRegistry.resolve("plugin:test-extension/echo");
      expect(def?.source).toBe("plugin");
      expect(def?.runtime).toBe("in_process");
    } finally {
      fs.rmSync(installBase, { recursive: true, force: true });
    }
  });

  it("executor allow path executes via registered handler; deny path invokes no backend", async () => {
    const installBase = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ext-exec-"));
    const allowPermission = new StubPermissionManager({ kind: "allow" });
    const { service, toolRegistry } = createService({
      installBaseDir: installBase,
      permission: allowPermission,
    });
    try {
      await service.installExtension(FIXTURE_DIR);
      await service.enableExtension("test-extension");
      expect(toolRegistry.hasTool("plugin:test-extension/echo")).toBe(true);

      let backendCalls = 0;
      service.registerToolHandler("plugin:test-extension/echo", async (input) => {
        backendCalls += 1;
        return { echoed: (input as { text: string }).text };
      });

      const okResult = await service.pluginExecutor.execute(
        "plugin:test-extension/echo",
        { text: "hello" },
        { toolCallId: createToolCallId() },
      );
      expect(okResult.isError).toBe(false);
      expect(okResult.result).toEqual({ echoed: "hello" });
      expect(backendCalls).toBe(1);
      expect(allowPermission.checks).toBeGreaterThan(0);

      const denyPermission = new StubPermissionManager({
        kind: "deny",
        reason: "policy says no",
      });
      const denied = createService({
        installBaseDir: fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ext-deny-")),
        permission: denyPermission,
        toolRegistry,
      });
      // Share the same registry/handler host: re-register service over the same tools.
      let deniedBackendCalls = 0;
      denied.service.registerToolHandler("plugin:test-extension/echo", async () => {
        deniedBackendCalls += 1;
        return "should-not-run";
      });
      // Enable state is tracked per-service; mark active via enable on shared repos.
      await denied.service.installExtension(FIXTURE_DIR);
      await denied.service.enableExtension("test-extension");

      const deniedResult = await denied.service.pluginExecutor.execute(
        "plugin:test-extension/echo",
        { text: "hello" },
        { toolCallId: createToolCallId() },
      );
      expect(deniedResult.isError).toBe(true);
      expect(deniedBackendCalls).toBe(0);
      expect(denyPermission.checks).toBe(1);
    } finally {
      fs.rmSync(installBase, { recursive: true, force: true });
    }
  });

  it("disable removes tools (idempotent) with history untouched; project A resolves, project B blocked", async () => {
    const installBase = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ext-disable-"));
    const { service, toolRegistry } = createService({ installBaseDir: installBase });
    try {
      await service.installExtension(FIXTURE_DIR);
      await service.enableExtension("test-extension");
      await service.setProjectEnabled("test-extension", "project-a", true);

      service.registerToolHandler("plugin:test-extension/echo", async (input) => ({
        echoed: (input as { text: string }).text,
      }));

      // Project A enabled resolves through the executor gate.
      const forA = await service.pluginExecutor.execute(
        "plugin:test-extension/echo",
        { text: "a" },
        { toolCallId: createToolCallId(), projectId: "project-a" },
      );
      expect(forA.isError).toBe(false);

      // Project B has no binding: blocked without backend.
      const forB = await service.pluginExecutor.execute(
        "plugin:test-extension/echo",
        { text: "b" },
        { toolCallId: createToolCallId(), projectId: "project-b" },
      );
      expect(forB.isError).toBe(true);
      expect((forB.metadata as Record<string, unknown> | undefined)?.["pluginStatus"]).toBe(
        "project-disabled",
      );

      // Snapshot the persisted record as "history", then disable twice.
      const before = await service.getExtension("test-extension");
      await service.disableExtension("test-extension");
      const disabled = await service.disableExtension("test-extension");
      expect(disabled.lifecycle).toBe("disabled");
      expect(toolRegistry.hasTool("plugin:test-extension/echo")).toBe(false);

      // History untouched: metadata record still present with same identity/hash.
      const after = await service.getExtension("test-extension");
      expect(after?.id).toBe(before?.id);
      expect(after?.manifestHash).toBe(before?.manifestHash);
      expect(after?.installedAt).toBe(before?.installedAt);
    } finally {
      fs.rmSync(installBase, { recursive: true, force: true });
    }
  });

  it("restart: new service instance over the same StorageDatabase restores installation+binding+hash", async () => {
    const { tmpDbPath, cleanup } = createTempDbPath("ai-desktop-ext-restart-");
    const installBase = fs.mkdtempSync(path.join(os.tmpdir(), "ai-desktop-ext-restart-files-"));
    try {
      const db = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db.initialize();
      const repository = new PrismaExtensionRepository(db);
      const bindings = new PrismaExtensionProjectBindingRepository(db);
      const permission = new StubPermissionManager({ kind: "allow" });

      const first = new ExtensionService({
        repository,
        bindingRepository: bindings,
        permissionManager: permission,
        installBaseDir: path.join(installBase, "v1"),
        toolRegistry: new PluginToolRegistry(),
      });
      const installed = await first.installExtension(FIXTURE_DIR);
      await first.enableExtension("test-extension");
      await first.setProjectEnabled("test-extension", "project-a", true);
      await db.close();

      // Restart: brand new database + service on the same file.
      const db2 = new StorageDatabase({ url: `file:${tmpDbPath.replace(/\\/g, "/")}` });
      await db2.initialize();
      const restarted = new ExtensionService({
        repository: new PrismaExtensionRepository(db2),
        bindingRepository: new PrismaExtensionProjectBindingRepository(db2),
        permissionManager: permission,
        installBaseDir: path.join(installBase, "v1"),
        toolRegistry: new PluginToolRegistry(),
      });
      await restarted.restore();

      const recovered = await restarted.getExtension("test-extension");
      expect(recovered?.id).toBe("test-extension");
      expect(recovered?.lifecycle).toBe("active");
      expect(recovered?.manifestHash).toBe(installed.manifestHash);
      expect(recovered?.enabledProjects).toContain("project-a");
      expect(restarted.toolRegistry.hasTool("plugin:test-extension/echo")).toBe(true);
      expect(await restarted.isEnabledForProject("test-extension", "project-a")).toBe(true);

      await db2.close();
    } finally {
      cleanup();
      fs.rmSync(installBase, { recursive: true, force: true });
    }
  });
});
