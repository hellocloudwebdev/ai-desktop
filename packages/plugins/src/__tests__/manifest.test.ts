import { describe, expect, it } from "vitest";
import {
  ExtensionManifestSchema,
  isSafeRelativePath,
  type ExtensionManifest,
} from "../core/manifest.js";

function validManifestInput(): Record<string, unknown> {
  return {
    id: "my-extension",
    name: "My Extension",
    version: "1.2.3",
    capabilities: ["tool.register", "workspace.view"],
    contributes: { tools: [] },
  };
}

describe("packages/plugins: ExtensionManifest (PR32)", () => {
  it("accepts a valid canonical extension manifest", () => {
    const parsed = ExtensionManifestSchema.parse(validManifestInput()) as ExtensionManifest;
    expect(parsed.id).toBe("my-extension");
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.capabilities).toEqual(["tool.register", "workspace.view"]);
  });

  it("accepts optional displayName/description/publisher/minimumHostVersion/metadata", () => {
    const parsed = ExtensionManifestSchema.parse({
      ...validManifestInput(),
      displayName: "My Extension Display",
      description: "A helpful extension",
      publisher: "acme",
      minimumHostVersion: "0.1.0",
      metadata: { homepage: "https://example.com" },
    }) as ExtensionManifest;
    expect(parsed.displayName).toBe("My Extension Display");
    expect(parsed.minimumHostVersion).toBe("0.1.0");
  });

  it("rejects a bad id (uppercase/underscores/leading dash)", () => {
    for (const bad of ["MyExtension", "my_extension", "-lead", "", "a".repeat(65)]) {
      const res = ExtensionManifestSchema.safeParse({ ...validManifestInput(), id: bad });
      expect(res.success, `id "${bad}" should fail`).toBe(false);
    }
  });

  it("rejects bad semver and accepts prerelease/build metadata", () => {
    expect(
      ExtensionManifestSchema.safeParse({ ...validManifestInput(), version: "v1.0" }).success,
    ).toBe(false);
    expect(
      ExtensionManifestSchema.safeParse({ ...validManifestInput(), version: "1.0" }).success,
    ).toBe(false);
    const okRes = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      version: "2.0.0-alpha.1+build.5",
    });
    expect(okRes.success).toBe(true);
  });

  it("rejects unknown capability", () => {
    const res = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      capabilities: ["tool.register", "teleport"],
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty capabilities (min 1)", () => {
    const res = ExtensionManifestSchema.safeParse({ ...validManifestInput(), capabilities: [] });
    expect(res.success).toBe(false);
  });

  it("normalizes duplicate capabilities (dedupe + sort)", () => {
    const parsed = ExtensionManifestSchema.parse({
      ...validManifestInput(),
      capabilities: ["workspace.view", "tool.register", "workspace.view", "tool.register"],
    }) as ExtensionManifest;
    expect(parsed.capabilities).toEqual(["tool.register", "workspace.view"]);
  });

  it("rejects oversized description (>1000 chars)", () => {
    const res = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      description: "x".repeat(1001),
    });
    expect(res.success).toBe(false);
  });

  it("rejects more than 16 contributed tools", () => {
    const tools = Array.from({ length: 17 }, (_, i) => ({
      name: `tool-${i}`,
      description: `Tool ${i}`,
    }));
    const res = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      contributes: { tools },
    });
    expect(res.success).toBe(false);
  });

  it("SECRET-SCAN: rejects metadata keys matching credential patterns", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "api-key",
      "password",
      "clientSecret",
      "accessToken",
      "access_token",
      "authToken",
      "github_token",
      "privateKey",
      "private_key",
      "token",
    ]) {
      const res = ExtensionManifestSchema.safeParse({
        ...validManifestInput(),
        metadata: { [key]: "value" },
      });
      expect(res.success, `key "${key}" should fail`).toBe(false);
    }
  });

  it("SECRET-SCAN: rejects metadata string values matching credential patterns", () => {
    const res = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      metadata: { note: "contains my apiKey here" },
    });
    expect(res.success).toBe(false);
  });

  it("SECRET-SCAN: allows benign metadata", () => {
    const res = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      metadata: { homepage: "https://example.com", tags: ["a", "b"] },
    });
    expect(res.success).toBe(true);
  });

  it("SECURITY: path traversal checks reject .. and absolute paths", () => {
    expect(isSafeRelativePath("../evil.js")).toBe(false);
    expect(isSafeRelativePath("tools/../../secret")).toBe(false);
    expect(isSafeRelativePath("./tool.js")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\system32")).toBe(false);
    expect(isSafeRelativePath("tools/run.js")).toBe(true);
    expect(isSafeRelativePath("SKILL.md")).toBe(true);
  });

  it("SECURITY: rejects traversal in tool entry", () => {
    const res = ExtensionManifestSchema.safeParse({
      ...validManifestInput(),
      contributes: {
        tools: [{ name: "evil", description: "evil", entry: "../../etc/passwd" }],
      },
    });
    expect(res.success).toBe(false);
  });
});
