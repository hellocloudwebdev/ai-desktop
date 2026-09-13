// PR32: apps/desktop — ExtensionService (desktop-owned orchestration)
//
// Composes @ai-desktop/plugins domain primitives + durable storage repos +
// PermissionManager:
//
//   - Persistence: ExtensionRepository (metadata/lifecycle/trust/hash) and
//     ExtensionProjectBindingRepository (per-project enablement), constructed
//     from getStorage().database mirroring the getSkillRepository pattern.
//   - Lifecycle/tools: ExtensionManager (installed -> enabled -> active;
//     disable unregisters tools) backed by a plugins-owned PluginToolRegistry.
//   - Execution: plugins-owned PluginToolExecutor consults the permission
//     gate first; handlers are host-registered via registerToolHandler().
//     Install of unknown tools without a handler still registers the
//     definition; execution then fails cleanly at runtime with a
//     not-implemented ToolResult.
//   - Install: plugins-owned validateExtensionPackage + file copy; no code
//     executes during install; trust after install is "untrusted".
//
// Invariants:
//   1. No code executes during install; install validates, copies files, persists.
//   2. Trust after install is "untrusted" (auto-assigned); trust never grants
//      runtime permission by itself.
//   3. Disabling unregisters the extension's tools immediately; history is
//      untouched (uninstall never rewrites events).
//   4. Restart recovery: a new service instance over the same StorageDatabase
//      restores installations, bindings, and hashes via restore().
//   5. No Prisma, no Electron, no provider/MCP SDK imports in this file beyond
//      the storage/permission abstractions (desktop owns composition only).
//   6. The plugins package owns manifest/registry/lifecycle/trust/executor
//      logic; this service owns host wiring (repos, handlers, install dir).

import fs from "node:fs";
import path from "node:path";
import type { PermissionManager } from "@ai-desktop/permissions";
import {
  ExtensionManager,
  ExtensionRegistry,
  PluginToolExecutor,
  PluginToolRegistry,
  buildPluginToolDefinition,
  validateExtensionPackage,
  type ExtensionLifecycle,
  type ExtensionManifest,
  type PluginToolHandler,
} from "@ai-desktop/plugins";
import type {
  ExtensionProjectBindingRepository,
  ExtensionRepository,
  StoredExtension,
} from "@ai-desktop/storage";
import type { ExtensionInfoPayload, ExtensionTrust } from "@ai-desktop/shared";

export interface ExtensionServiceOptions {
  readonly repository: ExtensionRepository;
  readonly bindingRepository: ExtensionProjectBindingRepository;
  readonly permissionManager: PermissionManager;
  readonly installBaseDir?: string;
  readonly toolRegistry?: PluginToolRegistry;
}

function parseManifestJson(raw: string): ExtensionManifest | null {
  try {
    const parsed = JSON.parse(raw) as {
      contributes?: { tools?: unknown[] };
    } & Record<string, unknown>;
    const tools = Array.isArray(parsed.contributes?.tools) ? parsed.contributes?.tools : [];
    return {
      ...parsed,
      contributes: { tools },
    } as ExtensionManifest;
  } catch {
    return null;
  }
}

function readCapabilities(stored: StoredExtension): string[] {
  try {
    const raw = JSON.parse(stored.manifest) as { capabilities?: unknown };
    return Array.isArray(raw.capabilities) ? (raw.capabilities as string[]) : [];
  } catch {
    return [];
  }
}

function toRegistryRecord(stored: StoredExtension): {
  id: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  capabilities: readonly string[];
  manifestHash: string;
  lifecycle: ExtensionLifecycle;
  trust: "untrusted" | "trusted" | "blocked";
  installPath?: string;
  installedAt: number;
  updatedAt: number;
} {
  return {
    id: stored.id,
    name: stored.name,
    version: stored.version,
    ...(stored.displayName != null ? { displayName: stored.displayName } : {}),
    ...(stored.description != null ? { description: stored.description } : {}),
    capabilities: readCapabilities(stored),
    manifestHash: stored.manifestHash,
    lifecycle: (["installed", "enabled", "active", "disabled"].includes(stored.lifecycle)
      ? stored.lifecycle
      : "installed") as ExtensionLifecycle,
    trust: (["untrusted", "trusted", "blocked"].includes(stored.trust)
      ? stored.trust
      : "untrusted") as "untrusted" | "trusted" | "blocked",
    ...(stored.installPath != null ? { installPath: stored.installPath } : {}),
    installedAt: stored.installedAt,
    updatedAt: stored.updatedAt,
  };
}
function toInfoPayload(
  stored: StoredExtension,
  enabledProjects: readonly string[],
): ExtensionInfoPayload {
  const lifecycle = (
    ["installed", "enabled", "active", "disabled"].includes(stored.lifecycle)
      ? stored.lifecycle
      : "installed"
  ) as ExtensionInfoPayload["lifecycle"];
  const trust = (
    ["untrusted", "trusted", "blocked"].includes(stored.trust) ? stored.trust : "untrusted"
  ) as ExtensionTrust;
  const payload: ExtensionInfoPayload = {
    id: stored.id,
    name: stored.name,
    version: stored.version,
    capabilities: readCapabilities(stored),
    lifecycle,
    trust,
    manifestHash: stored.manifestHash,
    installedAt: stored.installedAt,
    updatedAt: stored.updatedAt,
    enabledProjects: [...enabledProjects],
  };
  const withDisplayName =
    stored.displayName !== null && stored.displayName !== undefined
      ? { ...payload, displayName: stored.displayName }
      : payload;
  return stored.description !== null && stored.description !== undefined
    ? { ...withDisplayName, description: stored.description }
    : withDisplayName;
}

/**
 * Storage-backed ExtensionRepository adapter for the plugins-owned
 * ExtensionManager interface (save/get/list/setLifecycle/setTrust/delete).
 */
function adaptRepository(storage: ExtensionRepository) {
  return {
    save: async (record: {
      id: string;
      name: string;
      version: string;
      displayName?: string;
      description?: string;
      capabilities: readonly string[];
      manifestHash: string;
      lifecycle: ExtensionLifecycle;
      trust: string;
      installPath?: string;
      installedAt: number;
      updatedAt: number;
    }) => {
      const saved = await storage.saveExtension({
        id: record.id,
        name: record.name,
        version: record.version,
        ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
        ...(record.description !== undefined ? { description: record.description } : {}),
        manifest: JSON.stringify({
          id: record.id,
          name: record.name,
          version: record.version,
          capabilities: [...record.capabilities],
        }),
        manifestHash: record.manifestHash,
        lifecycle: record.lifecycle,
        trust: record.trust,
        ...(record.installPath !== undefined ? { installPath: record.installPath } : {}),
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
      });
      return {
        id: saved.id,
        name: saved.name,
        version: saved.version,
        ...(saved.displayName != null ? { displayName: saved.displayName } : {}),
        ...(saved.description != null ? { description: saved.description } : {}),
        capabilities: readCapabilities(saved),
        manifestHash: saved.manifestHash,
        lifecycle: saved.lifecycle as ExtensionLifecycle,
        trust: saved.trust as "untrusted" | "trusted" | "blocked",
        ...(saved.installPath != null ? { installPath: saved.installPath } : {}),
        installedAt: saved.installedAt,
        updatedAt: saved.updatedAt,
      };
    },
    get: async (id: string) => {
      const saved = await storage.getExtension(id);
      if (!saved) return undefined;
      return {
        id: saved.id,
        name: saved.name,
        version: saved.version,
        ...(saved.displayName != null ? { displayName: saved.displayName } : {}),
        ...(saved.description != null ? { description: saved.description } : {}),
        capabilities: readCapabilities(saved),
        manifestHash: saved.manifestHash,
        lifecycle: saved.lifecycle as ExtensionLifecycle,
        trust: saved.trust as "untrusted" | "trusted" | "blocked",
        ...(saved.installPath != null ? { installPath: saved.installPath } : {}),
        installedAt: saved.installedAt,
        updatedAt: saved.updatedAt,
      };
    },
    list: async () => {
      const all = await storage.listExtensions();
      return all.map((saved) => ({
        id: saved.id,
        name: saved.name,
        version: saved.version,
        ...(saved.displayName != null ? { displayName: saved.displayName } : {}),
        ...(saved.description != null ? { description: saved.description } : {}),
        capabilities: readCapabilities(saved),
        manifestHash: saved.manifestHash,
        lifecycle: saved.lifecycle as ExtensionLifecycle,
        trust: saved.trust as "untrusted" | "trusted" | "blocked",
        ...(saved.installPath != null ? { installPath: saved.installPath } : {}),
        installedAt: saved.installedAt,
        updatedAt: saved.updatedAt,
      }));
    },
    setLifecycle: async (id: string, lifecycle: ExtensionLifecycle) => {
      await storage.setLifecycle(id, lifecycle);
    },
    setTrust: async (id: string, trust: string) => {
      await storage.setTrust(id, trust);
    },
    delete: async (id: string) => {
      await storage.deleteExtension(id);
    },
  };
}

/**
 * Storage-backed binding adapter for the plugins-owned
 * ExtensionProjectBindingRepository interface (boolean-oriented).
 */
function adaptBindings(storage: ExtensionProjectBindingRepository) {
  return {
    setBinding: async (extensionId: string, projectId: string, enabled: boolean) => {
      await storage.setBinding(extensionId, projectId, enabled);
    },
    getBinding: async (extensionId: string, projectId: string): Promise<boolean | undefined> => {
      const row = await storage.getBinding(extensionId, projectId);
      return row?.enabled;
    },
    listForProject: async (projectId: string) => {
      const rows = await storage.listBindingsForProject(projectId);
      return rows.filter((r) => r.enabled).map((r) => r.extensionId);
    },
    deleteForExtension: async (extensionId: string) => {
      await storage.deleteBindingsForExtension(extensionId);
    },
  };
}

export class ExtensionService {
  private readonly _repository: ExtensionRepository;
  private readonly _bindings: ExtensionProjectBindingRepository;
  private readonly _installBaseDir: string;
  private readonly _toolRegistry: PluginToolRegistry;
  private readonly _handlers = new Map<string, PluginToolHandler>();
  private readonly _manager: ExtensionManager;
  private readonly _executor: PluginToolExecutor;
  private readonly _activeExtensions = new Set<string>();
  private readonly _projectGateCache = new Map<string, boolean>();

  constructor(options: ExtensionServiceOptions) {
    this._repository = options.repository;
    this._bindings = options.bindingRepository;
    this._installBaseDir =
      options.installBaseDir ?? path.resolve(process.cwd(), ".ai-desktop/extensions");
    this._toolRegistry = options.toolRegistry ?? new PluginToolRegistry();
    if (!fs.existsSync(this._installBaseDir)) {
      fs.mkdirSync(this._installBaseDir, { recursive: true });
    }
    this._manager = new ExtensionManager({
      registry: new ExtensionRegistry(),
      repository: adaptRepository(this._repository),
      bindingRepository: adaptBindings(this._bindings),
      toolRegistry: this._toolRegistry,
    });
    this._executor = new PluginToolExecutor({
      toolRegistry: this._toolRegistry,
      permissionManager: options.permissionManager,
      handlers: this._handlers,
      isEnabledForProject: (extensionId, projectId) =>
        this._projectGateCache.get(`${extensionId}:${projectId}`) ?? false,
      isExtensionActive: (extensionId) => this._activeExtensions.has(extensionId),
    });
  }

  get toolRegistry(): PluginToolRegistry {
    return this._toolRegistry;
  }

  get manager(): ExtensionManager {
    return this._manager;
  }

  get pluginExecutor(): PluginToolExecutor {
    return this._executor;
  }

  /**
   * Host-owned handler registration. Install of tools without a registered
   * handler still registers the definition; execution fails cleanly at
   * runtime with a not-implemented ToolResult (permission still consulted first).
   */
  registerToolHandler(toolName: string, handler: PluginToolHandler): void {
    this._handlers.set(toolName, handler);
  }

  unregisterToolHandler(toolName: string): boolean {
    return this._handlers.delete(toolName);
  }

  private _registerContribution(
    extensionId: string,
    manifestHash: string,
    tool: { name: string; description: string; parameters?: unknown; timeoutMs?: number },
  ): void {
    this._toolRegistry.registerTool(
      buildPluginToolDefinition(
        {
          extensionId,
          tool: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as Record<string, unknown> | undefined,
            timeoutMs: tool.timeoutMs,
          },
        },
        manifestHash,
      ),
    );
  }

  private async _enabledProjects(extensionId: string): Promise<string[]> {
    const bindings = await this._bindings.listBindingsForExtension(extensionId);
    return bindings.filter((b) => b.enabled).map((b) => b.projectId);
  }

  private async _warmProjectGate(extensionId: string): Promise<void> {
    const bindings = await this._bindings.listBindingsForExtension(extensionId);
    for (const b of bindings) {
      this._projectGateCache.set(`${extensionId}:${b.projectId}`, b.enabled);
    }
  }

  /**
   * Mirrors a stored row into the manager's in-memory registry, replacing
   * any stale entry. Required before manager lifecycle calls on service
   * instances that never ran restore() (manager transitions validate
   * against the in-memory record).
   */
  private _ensureRegistryRecord(stored: StoredExtension): void {
    if (this._manager.registry.has(stored.id)) {
      this._manager.registry.unregister(stored.id);
    }
    this._manager.registry.register(toRegistryRecord(stored));
  }

  /**
   * Restores installations, bindings, and hashes after a restart: re-registers
   * in-memory active flags and tool definitions for lifecycle "active"
   * extensions from the same StorageDatabase. Call once at startup when
   * constructing over an existing database.
   */
  async restore(): Promise<void> {
    const stored = await this._repository.listExtensions();
    for (const ext of stored) {
      await this._warmProjectGate(ext.id);
      if (ext.lifecycle !== "active" && ext.lifecycle !== "enabled") {
        continue;
      }
      const manifest = parseManifestJson(ext.manifest);
      if (!manifest) continue;
      // Rebuild the manager's in-memory registry state for restore.
      this._ensureRegistryRecord(ext);
      this._activeExtensions.add(ext.id);
      if (ext.lifecycle === "active") {
        for (const tool of manifest.contributes?.tools ?? []) {
          this._registerContribution(ext.id, ext.manifestHash, {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            timeoutMs: tool.timeoutMs,
          });
        }
      }
    }
  }

  async listExtensions(projectId?: string): Promise<ExtensionInfoPayload[]> {
    const stored = await this._repository.listExtensions();
    const infos: ExtensionInfoPayload[] = [];
    for (const ext of stored) {
      const enabledProjects = await this._enabledProjects(ext.id);
      if (projectId !== undefined && !enabledProjects.includes(projectId)) {
        continue;
      }
      infos.push(toInfoPayload(ext, enabledProjects));
    }
    return infos;
  }

  async getExtension(extensionId: string): Promise<ExtensionInfoPayload | undefined> {
    const stored = await this._repository.getExtension(extensionId);
    if (!stored) return undefined;
    return toInfoPayload(stored, await this._enabledProjects(extensionId));
  }

  /**
   * Installs an extension package: validate (plugins-owned) -> copy files ->
   * persist metadata -> register in the manager. Runs zero code; trust is
   * auto-assigned "untrusted".
   */
  async installExtension(
    sourceDir: string,
    options?: { projectId?: string },
  ): Promise<ExtensionInfoPayload> {
    const validated = validateExtensionPackage(sourceDir);
    if (!validated.ok) {
      throw validated.error;
    }
    const { manifest, manifestHash } = validated.value;
    const targetDir = path.join(this._installBaseDir, manifest.id);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    try {
      fs.cpSync(sourceDir, targetDir, { recursive: true });
    } catch (copyErr: unknown) {
      if (fs.existsSync(targetDir)) {
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      }
      throw new Error(
        `Failed to copy extension files to "${targetDir}": ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
      );
    }

    const ts = Date.now();
    const stored = await this._repository.saveExtension({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      displayName: manifest.displayName ?? null,
      description: manifest.description ?? null,
      manifest: JSON.stringify(manifest),
      manifestHash,
      lifecycle: "installed",
      trust: "untrusted",
      installPath: targetDir,
      installedAt: ts,
      updatedAt: ts,
    });
    // Mirror into the manager's in-memory registry (tolerate stale entry).
    this._ensureRegistryRecord({
      ...stored,
      lifecycle: "installed",
      trust: "untrusted",
      manifestHash,
      installedAt: ts,
      updatedAt: ts,
    });

    if (options?.projectId !== undefined) {
      await this._bindings.setBinding(manifest.id, options.projectId, true);
      this._projectGateCache.set(`${manifest.id}:${options.projectId}`, true);
    }

    return toInfoPayload(stored, await this._enabledProjects(manifest.id));
  }

  async uninstallExtension(extensionId: string): Promise<void> {
    const existing = await this._repository.getExtension(extensionId);
    this._activeExtensions.delete(extensionId);
    this._toolRegistry.unregisterExtensionTools(extensionId);
    for (const key of [...this._projectGateCache.keys()]) {
      if (key.startsWith(`${extensionId}:`)) {
        this._projectGateCache.delete(key);
      }
    }
    const existingRecord = await this._repository.getExtension(extensionId);
    if (existingRecord) {
      this._ensureRegistryRecord(existingRecord);
    }
    await this._manager.uninstall(extensionId).catch(() => {
      // Fall through to direct cleanup when the in-memory registry has no
      // record (e.g. a service instance that never ran restore()).
    });
    await this._bindings.deleteBindingsForExtension(extensionId);
    await this._repository.deleteExtension(extensionId);
    if (existing?.installPath && fs.existsSync(existing.installPath)) {
      try {
        fs.rmSync(existing.installPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  /**
   * Enables an extension: installed/disabled -> enabled -> active (via the
   * plugins-owned manager), then registers each manifest contributes.tools
   * definition via buildPluginToolDefinition + registerTool.
   */
  async enableExtension(extensionId: string): Promise<ExtensionInfoPayload> {
    const stored = await this._repository.getExtension(extensionId);
    if (!stored) {
      throw new Error(`Extension "${extensionId}" is not installed`);
    }
    if (stored.trust === "blocked") {
      throw new Error(`Extension "${extensionId}" is blocked and cannot be enabled`);
    }
    if (stored.lifecycle === "active") {
      this._activeExtensions.add(extensionId);
      await this._warmProjectGate(extensionId);
      return toInfoPayload(stored, await this._enabledProjects(extensionId));
    }

    const manifest = parseManifestJson(stored.manifest);
    if (!manifest) {
      throw new Error(`Extension "${extensionId}" has a corrupt manifest record`);
    }
    this._ensureRegistryRecord(stored);
    const enabled = await this._manager.enable(extensionId);
    if (!enabled.ok) {
      throw enabled.error;
    }
    const activated = await this._manager.activate(extensionId);
    if (!activated.ok) {
      throw activated.error;
    }
    this._activeExtensions.add(extensionId);
    await this._warmProjectGate(extensionId);

    for (const tool of manifest.contributes?.tools ?? []) {
      const registered = this._manager.registerContribution(extensionId, {
        name: tool.name,
        description: tool.description,
        ...(tool.parameters !== undefined
          ? { parameters: tool.parameters as Record<string, unknown> }
          : {}),
        ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
      });
      if (!registered.ok) {
        throw registered.error;
      }
    }

    const updated = await this._repository.getExtension(extensionId);
    if (!updated) {
      throw new Error(`Extension "${extensionId}" vanished during enable`);
    }
    return toInfoPayload(updated, await this._enabledProjects(extensionId));
  }

  /**
   * Disables an extension: unregisters its tools immediately and records
   * lifecycle "disabled" (via the plugins-owned manager). Idempotent:
   * disabling a non-active extension is a no-op success.
   */
  async disableExtension(extensionId: string): Promise<ExtensionInfoPayload> {
    const stored = await this._repository.getExtension(extensionId);
    if (!stored) {
      throw new Error(`Extension "${extensionId}" is not installed`);
    }
    this._activeExtensions.delete(extensionId);
    this._toolRegistry.unregisterExtensionTools(extensionId);
    if (stored.lifecycle === "disabled" || stored.lifecycle === "installed") {
      return toInfoPayload(stored, await this._enabledProjects(extensionId));
    }
    this._ensureRegistryRecord(stored);
    const disabled = await this._manager.disable(extensionId);
    if (!disabled.ok) {
      throw disabled.error;
    }
    const updated = await this._repository.getExtension(extensionId);
    if (!updated) {
      throw new Error(`Extension "${extensionId}" vanished during disable`);
    }
    return toInfoPayload(updated, await this._enabledProjects(extensionId));
  }

  async setProjectEnabled(
    extensionId: string,
    projectId: string,
    enabled: boolean,
  ): Promise<ExtensionInfoPayload> {
    const stored = await this._repository.getExtension(extensionId);
    if (!stored) {
      throw new Error(`Extension "${extensionId}" is not installed`);
    }
    this._ensureRegistryRecord(stored);
    await this._manager.setProjectEnabled(extensionId, projectId, enabled);
    this._projectGateCache.set(`${extensionId}:${projectId}`, enabled);
    const updated = await this._repository.getExtension(extensionId);
    if (!updated) {
      throw new Error(`Extension "${extensionId}" vanished during project update`);
    }
    return toInfoPayload(updated, await this._enabledProjects(extensionId));
  }

  /**
   * Async project gate: stored binding, defaulting to false when no binding
   * exists. Sync executor gate reads the warmed cache (warmed on
   * install/enable/setProjectEnabled/restore).
   */
  async isEnabledForProject(extensionId: string, projectId?: string): Promise<boolean> {
    if (projectId === undefined) {
      return this._activeExtensions.has(extensionId);
    }
    return this._manager.isEnabledForProject(extensionId, projectId);
  }
}
