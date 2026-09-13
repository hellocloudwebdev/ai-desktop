// PR32: packages/plugins — Extension Manager (pure-ish orchestration)
//
// Invariants:
//   1. Manager is pure-ish: persistence goes through the ExtensionRepository
//      and ExtensionProjectBindingRepository interfaces defined here in plugins.
//   2. Tool registration happens only on activate (lifecycle "active"); disable
//      unregisters the extension's tools immediately.
//   3. Project bindings: isEnabledForProject(id, projectId) returns the stored
//      binding, defaulting to false when a projectId is given and no binding exists.
//   4. Global active tools require lifecycle === "active".

import { ValidationError, type Result, ok, err } from "@ai-desktop/shared";
import type { ExtensionLifecycle } from "./lifecycle.js";
import { assertTransition } from "./lifecycle.js";
import type { TrustState } from "./extension-trust.js";
import type { ExtensionRecord } from "./extension-registry.js";
import { ExtensionManifestSchema, type ExtensionManifest } from "./manifest.js";
import { computeExtensionDefinitionHash } from "./extension-trust.js";
import {
  buildPluginToolDefinition,
  type PluginToolRegistry,
} from "../tools/extension-tool-contribution.js";

export interface PersistedExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly manifestHash: string;
  readonly lifecycle: ExtensionLifecycle;
  readonly trust: TrustState;
  readonly installPath?: string;
  readonly installedAt: number;
  readonly updatedAt: number;
}

export interface ExtensionRepository {
  save(record: PersistedExtension): Promise<PersistedExtension>;
  get(id: string): Promise<PersistedExtension | undefined>;
  list(): Promise<readonly PersistedExtension[]>;
  setLifecycle(id: string, lifecycle: ExtensionLifecycle): Promise<void>;
  setTrust(id: string, trust: TrustState): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ExtensionProjectBindingRepository {
  setBinding(extensionId: string, projectId: string, enabled: boolean): Promise<void>;
  getBinding(extensionId: string, projectId: string): Promise<boolean | undefined>;
  listForProject(projectId: string): Promise<readonly string[]>;
  deleteForExtension(extensionId: string): Promise<void>;
}

export interface ExtensionManagerOptions {
  readonly registry: import("./extension-registry.js").ExtensionRegistry;
  readonly repository: ExtensionRepository;
  readonly bindingRepository: ExtensionProjectBindingRepository;
  readonly toolRegistry: PluginToolRegistry;
  readonly onLifecycleChange?: (id: string, lifecycle: ExtensionLifecycle) => void;
}

function toRecord(persisted: PersistedExtension): ExtensionRecord {
  return {
    id: persisted.id,
    name: persisted.name,
    version: persisted.version,
    displayName: persisted.displayName,
    description: persisted.description,
    capabilities: persisted.capabilities,
    manifestHash: persisted.manifestHash,
    lifecycle: persisted.lifecycle,
    trust: persisted.trust,
    installPath: persisted.installPath,
    installedAt: persisted.installedAt,
    updatedAt: persisted.updatedAt,
  };
}

export class ExtensionManager {
  private readonly _registry: import("./extension-registry.js").ExtensionRegistry;
  private readonly _repository: ExtensionRepository;
  private readonly _bindings: ExtensionProjectBindingRepository;
  private readonly _tools: PluginToolRegistry;
  private readonly _onLifecycleChange?: (id: string, lifecycle: ExtensionLifecycle) => void;

  constructor(options: ExtensionManagerOptions) {
    this._registry = options.registry;
    this._repository = options.repository;
    this._bindings = options.bindingRepository;
    this._tools = options.toolRegistry;
    this._onLifecycleChange = options.onLifecycleChange;
  }

  get registry(): import("./extension-registry.js").ExtensionRegistry {
    return this._registry;
  }

  get toolRegistry(): PluginToolRegistry {
    return this._tools;
  }

  /**
   * Installs a validated manifest: persists the record and registers metadata.
   */
  async install(
    manifest: ExtensionManifest,
    installPath?: string,
  ): Promise<Result<ExtensionRecord, ValidationError>> {
    const manifestHash = computeExtensionDefinitionHash({
      id: manifest.id,
      version: manifest.version,
      capabilities: manifest.capabilities,
      contributes: manifest.contributes,
    });
    const nowMs = Date.now();
    const persisted: PersistedExtension = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      capabilities: [...manifest.capabilities],
      manifestHash,
      lifecycle: "installed",
      trust: "untrusted",
      installPath,
      installedAt: nowMs,
      updatedAt: nowMs,
    };
    try {
      const saved = await this._repository.save(persisted);
      const record = toRecord(saved);
      // Re-register in-memory (tolerate stale entry from a previous install).
      if (this._registry.has(record.id)) {
        this._registry.unregister(record.id);
      }
      this._registry.register(record);
      return ok(record);
    } catch (persistErr: unknown) {
      return err(
        new ValidationError(
          `Failed to install extension "${manifest.id}": ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
        ),
      );
    }
  }

  /**
   * Installs from an unknown (unvalidated) manifest value: schema-validates first.
   */
  async installUnknown(
    raw: unknown,
    installPath?: string,
  ): Promise<Result<ExtensionRecord, ValidationError>> {
    const parsed = ExtensionManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ");
      return err(new ValidationError(`Invalid extension manifest: ${issues}`));
    }
    return this.install(parsed.data, installPath);
  }

  private async _transition(
    id: string,
    to: ExtensionLifecycle,
  ): Promise<Result<ExtensionRecord, ValidationError>> {
    const record = this._registry.get(id);
    if (!record) {
      return err(new ValidationError(`Extension "${id}" is not installed`));
    }
    if (record.lifecycle === to) {
      return ok(record); // idempotent
    }
    try {
      assertTransition(record.lifecycle, to);
    } catch (e: unknown) {
      return err(e as ValidationError);
    }
    await this._repository.setLifecycle(id, to);
    const updated = this._registry.setLifecycle(id, to);
    this._onLifecycleChange?.(id, to);
    return ok(updated);
  }

  async enable(id: string): Promise<Result<ExtensionRecord, ValidationError>> {
    return this._transition(id, "enabled");
  }

  async disable(id: string): Promise<Result<ExtensionRecord, ValidationError>> {
    const res = await this._transition(id, "disabled");
    if (res.ok) {
      // Disabling unregisters the extension's tools immediately.
      this._tools.unregisterExtensionTools(id);
    }
    return res;
  }

  async activate(id: string): Promise<Result<readonly string[], ValidationError>> {
    const record = this._registry.get(id);
    if (!record) {
      return err(new ValidationError(`Extension "${id}" is not installed`));
    }
    if (record.lifecycle === "active") {
      return ok(
        this._tools
          .listTools()
          .map((t) => t.name)
          .filter((n) => n.startsWith(`plugin:${id}/`)),
      );
    }
    const res = await this._transition(id, "active");
    if (!res.ok) {
      return err(res.error);
    }
    // Register contributed tools from persisted capabilities/manifest hash.
    const persisted = await this._repository.get(id);
    const names: string[] = [];
    // Tool contributions are stored implicitly: re-derive canonical names from
    // currently-registered definitions is impossible post-disable, so the host
    // re-registers via registerContribution; here we register nothing new and
    // return the (empty) active set unless contributions were pre-registered.
    void persisted;
    for (const tool of this._tools.listTools()) {
      if (tool.name.startsWith(`plugin:${id}/`)) {
        names.push(tool.name);
      }
    }
    return ok(names);
  }

  /**
   * Registers a single tool contribution for an ACTIVE extension.
   */
  registerContribution(
    extensionId: string,
    tool: {
      name: string;
      description: string;
      parameters?: Record<string, unknown>;
      timeoutMs?: number;
    },
  ): Result<string, ValidationError> {
    const record = this._registry.get(extensionId);
    if (!record) {
      return err(new ValidationError(`Extension "${extensionId}" is not installed`));
    }
    if (record.lifecycle !== "active") {
      return err(
        new ValidationError(
          `Cannot register tools: extension "${extensionId}" is not active (state: ${record.lifecycle})`,
        ),
      );
    }
    const def = buildPluginToolDefinition({ extensionId, tool }, record.manifestHash);
    this._tools.registerTool(def);
    return ok(def.name);
  }

  async deactivate(id: string): Promise<Result<ExtensionRecord, ValidationError>> {
    const record = this._registry.get(id);
    if (!record) {
      return err(new ValidationError(`Extension "${id}" is not installed`));
    }
    if (record.lifecycle === "enabled" || record.lifecycle === "disabled") {
      return ok(record); // already inactive
    }
    if (record.lifecycle !== "active") {
      return err(
        new ValidationError(`Cannot deactivate extension "${id}" from state "${record.lifecycle}"`),
      );
    }
    this._tools.unregisterExtensionTools(id);
    // active may only transition to disabled per the lifecycle state machine.
    return this._transition(id, "disabled");
  }

  /**
   * Uninstalls: disables (unregisters tools), deletes bindings, deletes record.
   */
  async uninstall(id: string): Promise<Result<void, ValidationError>> {
    const record = this._registry.get(id);
    if (!record) {
      return err(new ValidationError(`Extension "${id}" is not installed`));
    }
    this._tools.unregisterExtensionTools(id);
    await this._bindings.deleteForExtension(id);
    await this._repository.delete(id);
    this._registry.unregister(id);
    this._onLifecycleChange?.(id, "uninstalled");
    return ok(undefined);
  }

  async setProjectEnabled(extensionId: string, projectId: string, enabled: boolean): Promise<void> {
    const record = this._registry.get(extensionId);
    if (!record) {
      throw new ValidationError(`Extension "${extensionId}" is not installed`);
    }
    await this._bindings.setBinding(extensionId, projectId, enabled);
  }

  /**
   * Per-project enablement: stored binding, defaulting to false when a
   * projectId is given and no binding exists.
   */
  async isEnabledForProject(extensionId: string, projectId?: string): Promise<boolean> {
    if (projectId === undefined) {
      const record = this._registry.get(extensionId);
      return record?.lifecycle === "active";
    }
    const binding = await this._bindings.getBinding(extensionId, projectId);
    return binding ?? false;
  }

  /**
   * Synchronous variant for tool-resolution hot paths (uses cached bindings).
   * Hosts that need async storage should use isEnabledForProject instead.
   */
  createProjectGate(
    bindings: ReadonlyMap<string, boolean>,
  ): (extensionId: string, projectId: string) => boolean {
    return (extensionId, projectId) => bindings.get(`${extensionId}:${projectId}`) ?? false;
  }
}
