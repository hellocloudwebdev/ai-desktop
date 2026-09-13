import { describe, expect, it } from "vitest";
import {
  PluginToolRegistry,
  toCanonicalPluginToolId,
  parseCanonicalPluginToolId,
  computePluginToolDefinitionHash,
  buildPluginToolDefinition,
} from "../tools/extension-tool-contribution.js";

describe("packages/plugins: plugin tool contributions (PR32)", () => {
  it("builds canonical ids plugin:<id>/<tool>", () => {
    expect(toCanonicalPluginToolId("ext-a", "summarize")).toBe("plugin:ext-a/summarize");
  });

  it("parses canonical ids and rejects non-plugin ids", () => {
    expect(parseCanonicalPluginToolId("plugin:ext-a/summarize")).toEqual({
      extensionId: "ext-a",
      toolName: "summarize",
    });
    expect(parseCanonicalPluginToolId("skill:ext-a/summarize")).toBeNull();
    expect(parseCanonicalPluginToolId("plugin:no-slash")).toBeNull();
  });

  it("builds a ToolDefinition with source plugin / runtime in_process / requiredPermissions [plugin]", () => {
    const def = buildPluginToolDefinition(
      { extensionId: "ext-a", tool: { name: "summarize", description: "Summarizes text" } },
      "manifest-hash",
    );
    expect(def.name).toBe("plugin:ext-a/summarize");
    expect(def.source).toBe("plugin");
    expect(def.runtime).toBe("in_process");
    expect(def.requiredPermissions).toEqual(["plugin"]);
    expect(def.metadata?.["extensionId"]).toBe("ext-a");
    expect(def.metadata?.["toolName"]).toBe("summarize");
    expect(def.metadata?.["manifestHash"]).toBe("manifest-hash");
    expect(typeof def.metadata?.["definitionHash"]).toBe("string");
  });

  it("definition hash is stable and changes on description edit", () => {
    const h1 = computePluginToolDefinitionHash({
      name: "plugin:ext-a/t",
      description: "v1",
      parameters: {},
    });
    const h2 = computePluginToolDefinitionHash({
      name: "plugin:ext-a/t",
      description: "v1",
      parameters: {},
    });
    const h3 = computePluginToolDefinitionHash({
      name: "plugin:ext-a/t",
      description: "v2",
      parameters: {},
    });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("registry register/resolve/has/list/unregister per tool", () => {
    const r = new PluginToolRegistry();
    const def = buildPluginToolDefinition(
      { extensionId: "ext-a", tool: { name: "t", description: "T" } },
      "h",
    );
    r.registerTool(def);
    expect(r.hasTool(def.name)).toBe(true);
    expect(r.resolve(def.name)?.description).toBe("T");
    expect(r.listTools()).toHaveLength(1);
    expect(r.unregisterTool(def.name)).toBe(true);
    expect(r.hasTool(def.name)).toBe(false);
  });

  it("unregisterExtensionTools removes only that extension's tools", () => {
    const r = new PluginToolRegistry();
    r.registerTool(
      buildPluginToolDefinition({ extensionId: "a", tool: { name: "t1", description: "T1" } }, "h"),
    );
    r.registerTool(
      buildPluginToolDefinition({ extensionId: "a", tool: { name: "t2", description: "T2" } }, "h"),
    );
    r.registerTool(
      buildPluginToolDefinition({ extensionId: "b", tool: { name: "t1", description: "T1" } }, "h"),
    );
    expect(r.unregisterExtensionTools("a")).toBe(2);
    expect(r.listTools().map((t) => t.name)).toEqual(["plugin:b/t1"]);
  });

  it("resolveForProject enforces per-project enablement", () => {
    const r = new PluginToolRegistry();
    r.registerTool(
      buildPluginToolDefinition({ extensionId: "a", tool: { name: "t", description: "T" } }, "h"),
    );
    const gate = (ext: string, proj: string): boolean => ext === "a" && proj === "p1";
    expect(r.resolveForProject("plugin:a/t", "p1", gate)?.name).toBe("plugin:a/t");
    expect(r.resolveForProject("plugin:a/t", "p2", gate)).toBeUndefined();
    expect(r.resolveForProject("plugin:missing/t", "p1", gate)).toBeUndefined();
  });
});
