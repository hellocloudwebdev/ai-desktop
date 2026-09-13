import { describe, expect, it } from "vitest";
import { ExtensionRegistry } from "../core/extension-registry.js";
import {
  ExtensionManager,
  type ExtensionRepository,
  type ExtensionProjectBindingRepository,
  type PersistedExtension,
} from "../core/extension-manager.js";
import { PluginToolRegistry } from "../tools/extension-tool-contribution.js";
import type { ExtensionLifecycle } from "../core/lifecycle.js";
import type { TrustState } from "../core/extension-trust.js";
import type { ExtensionManifest } from "../core/manifest.js";

function manifest(id = "ext-a"): ExtensionManifest {
  return {
    id,
    name: "Ext A",
    version: "1.0.0",
    capabilities: ["tool.register"],
    contributes: { tools: [] },
  } as ExtensionManifest;
}

function inMemoryRepos() {
  const store = new Map<string, PersistedExtension>();
  const bindings = new Map<string, boolean>();
  const repository: ExtensionRepository = {
    save: async (r) => {
      store.set(r.id, r);
      return r;
    },
    get: async (id) => store.get(id),
    list: async () => [...store.values()],
    setLifecycle: async (id, lifecycle: ExtensionLifecycle) => {
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, lifecycle, updatedAt: Date.now() });
    },
    setTrust: async (id, trust: TrustState) => {
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, trust, updatedAt: Date.now() });
    },
    delete: async (id) => {
      store.delete(id);
    },
  };
  const bindingRepository: ExtensionProjectBindingRepository = {
    setBinding: async (ext, proj, enabled) => {
      bindings.set(`${ext}:${proj}`, enabled);
    },
    getBinding: async (ext, proj) => bindings.get(`${ext}:${proj}`),
    listForProject: async (proj) =>
      [...bindings.entries()]
        .filter(([k, v]) => k.endsWith(`:${proj}`) && v)
        .map(([k]) => k.split(":")[0]),
    deleteForExtension: async (ext) => {
      for (const k of [...bindings.keys()]) {
        if (k.startsWith(`${ext}:`)) bindings.delete(k);
      }
    },
  };
  return { store, bindings, repository, bindingRepository };
}

function setup() {
  const repos = inMemoryRepos();
  const registry = new ExtensionRegistry();
  const toolRegistry = new PluginToolRegistry();
  const manager = new ExtensionManager({
    registry,
    repository: repos.repository,
    bindingRepository: repos.bindingRepository,
    toolRegistry,
  });
  return { ...repos, registry, toolRegistry, manager };
}

describe("packages/plugins: ExtensionManager (PR32)", () => {
  it("install persists and registers metadata", async () => {
    const { manager, registry, store } = setup();
    const res = await manager.install(manifest());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.lifecycle).toBe("installed");
    expect(registry.get("ext-a")?.id).toBe("ext-a");
    expect(store.get("ext-a")?.trust).toBe("untrusted");
  });

  it("installUnknown rejects invalid manifests", async () => {
    const { manager } = setup();
    const res = await manager.installUnknown({ id: "BAD!", version: "x" });
    expect(res.ok).toBe(false);
  });

  it("enable -> activate -> registerContribution -> disable unregisters tools", async () => {
    const { manager, toolRegistry } = setup();
    await manager.install(manifest());
    expect((await manager.enable("ext-a")).ok).toBe(true);
    // enable is idempotent
    expect((await manager.enable("ext-a")).ok).toBe(true);
    const act = await manager.activate("ext-a");
    expect(act.ok).toBe(true);
    const reg = manager.registerContribution("ext-a", {
      name: "helper",
      description: "Helps",
    });
    expect(reg.ok).toBe(true);
    expect(toolRegistry.hasTool("plugin:ext-a/helper")).toBe(true);
    const dis = await manager.disable("ext-a");
    expect(dis.ok).toBe(true);
    expect(toolRegistry.hasTool("plugin:ext-a/helper")).toBe(false);
  });

  it("activate from installed (skipping enabled) fails", async () => {
    const { manager } = setup();
    await manager.install(manifest());
    const act = await manager.activate("ext-a");
    expect(act.ok).toBe(false);
  });

  it("registerContribution while not active fails", async () => {
    const { manager } = setup();
    await manager.install(manifest());
    await manager.enable("ext-a");
    const reg = manager.registerContribution("ext-a", { name: "t", description: "T" });
    expect(reg.ok).toBe(false);
  });

  it("deactivate returns to disabled and unregisters tools", async () => {
    const { manager, toolRegistry, registry } = setup();
    await manager.install(manifest());
    await manager.enable("ext-a");
    await manager.activate("ext-a");
    manager.registerContribution("ext-a", { name: "t", description: "T" });
    const de = await manager.deactivate("ext-a");
    expect(de.ok).toBe(true);
    expect(registry.get("ext-a")?.lifecycle).toBe("disabled");
    expect(toolRegistry.hasTool("plugin:ext-a/t")).toBe(false);
  });

  it("uninstall removes record, tools, and bindings", async () => {
    const { manager, registry, toolRegistry, store, bindings } = setup();
    await manager.install(manifest());
    await manager.enable("ext-a");
    await manager.activate("ext-a");
    manager.registerContribution("ext-a", { name: "t", description: "T" });
    await manager.setProjectEnabled("ext-a", "proj-a", true);
    const un = await manager.uninstall("ext-a");
    expect(un.ok).toBe(true);
    expect(registry.get("ext-a")).toBeUndefined();
    expect(store.get("ext-a")).toBeUndefined();
    expect(toolRegistry.listTools()).toHaveLength(0);
    expect(bindings.size).toBe(0);
  });

  it("project isolation: A enabled, B disabled", async () => {
    const { manager } = setup();
    await manager.install(manifest());
    await manager.setProjectEnabled("ext-a", "proj-a", true);
    await manager.setProjectEnabled("ext-a", "proj-b", false);
    expect(await manager.isEnabledForProject("ext-a", "proj-a")).toBe(true);
    expect(await manager.isEnabledForProject("ext-a", "proj-b")).toBe(false);
    // No binding -> defaults to false when projectId given
    expect(await manager.isEnabledForProject("ext-a", "proj-c")).toBe(false);
  });

  it("global active check requires lifecycle active", async () => {
    const { manager } = setup();
    await manager.install(manifest());
    expect(await manager.isEnabledForProject("ext-a")).toBe(false);
    await manager.enable("ext-a");
    expect(await manager.isEnabledForProject("ext-a")).toBe(false);
    await manager.activate("ext-a");
    expect(await manager.isEnabledForProject("ext-a")).toBe(true);
  });

  it("setProjectEnabled on unknown extension throws", async () => {
    const { manager } = setup();
    await expect(manager.setProjectEnabled("ghost", "p", true)).rejects.toThrow();
  });
});
