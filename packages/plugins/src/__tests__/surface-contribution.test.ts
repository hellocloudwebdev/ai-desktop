// PR33.12/33.13: plugins + mcp — Surface Integration Tests
//
// MCP tools and plugin tools stamp validated surface descriptors additively;
// the SurfaceService (tested separately) enforces binding hash match.

import { describe, expect, it } from "vitest";
import { buildSurfaceMetadata, extractSurfaceDescriptor } from "@ai-desktop/ai-core";
import { ExtensionManifestSchema, type PluginSurfaceContribution } from "../core/manifest.js";

const SURFACE = {
  id: "weather-card",
  version: "1.0.0",
  kind: "document",
  title: "Weather",
} as const;

describe("plugins: surface contribution contract (PR33.13)", () => {
  it("accepts a valid surfaces contribution alongside tools", () => {
    const res = ExtensionManifestSchema.safeParse({
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      capabilities: ["tool.register"],
      contributes: {
        tools: [
          {
            name: "current",
            description: "Current weather",
            parameters: { type: "object", properties: {} },
          },
        ],
        surfaces: [
          { toolName: "current", surfaceId: "weather-card", kind: "document", title: "Weather" },
        ],
      },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.contributes.surfaces).toHaveLength(1);
      const [contribution] = res.data.contributes.surfaces as PluginSurfaceContribution[];
      expect(contribution.toolName).toBe("current");
      expect(contribution.kind).toBe("document");
    }
  });

  it("rejects non-renderable and unknown surface kinds", () => {
    for (const kind of ["application", "hologram", ""]) {
      const res = ExtensionManifestSchema.safeParse({
        id: "weather",
        name: "Weather",
        version: "1.0.0",
        capabilities: ["tool.register"],
        contributes: {
          tools: [],
          surfaces: [{ toolName: "current", surfaceId: "s", kind }],
        },
      });
      expect(res.success, `kind "${kind}" should fail`).toBe(false);
    }
  });

  it("caps surfaces at 8 per manifest", () => {
    const surfaces = Array.from({ length: 9 }, (_, i) => ({
      toolName: `tool-${i}`,
      surfaceId: `surface-${i}`,
      kind: "table",
    }));
    const res = ExtensionManifestSchema.safeParse({
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      capabilities: ["tool.register"],
      contributes: { tools: [], surfaces },
    });
    expect(res.success).toBe(false);
  });

  it("stamped metadata round-trips through the additive convention", () => {
    const stamped = buildSurfaceMetadata(SURFACE as never);
    expect(extractSurfaceDescriptor(stamped)).toMatchObject({ id: "weather-card" });
    expect(extractSurfaceDescriptor({})).toBeNull();
  });
});
