import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExtensionPackage } from "../core/extension-installer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makePkg(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-pkg-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function goodManifest(): Record<string, unknown> {
  return {
    id: "ext-a",
    name: "Ext A",
    version: "1.0.0",
    capabilities: ["tool.register"],
    contributes: { tools: [{ name: "run", description: "Runs", entry: "run.js" }] },
  };
}

describe("packages/plugins: validateExtensionPackage (PR32)", () => {
  it("accepts a valid package and computes a manifest hash", () => {
    const dir = makePkg({
      "manifest.json": JSON.stringify(goodManifest()),
      "run.js": "console.log(1)",
    });
    const res = validateExtensionPackage(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.manifest.id).toBe("ext-a");
    expect(res.value.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects missing manifest.json", () => {
    const dir = makePkg({ "run.js": "x" });
    expect(validateExtensionPackage(dir).ok).toBe(false);
  });

  it("rejects invalid manifest schema", () => {
    const dir = makePkg({ "manifest.json": JSON.stringify({ id: "BAD", version: "x" }) });
    expect(validateExtensionPackage(dir).ok).toBe(false);
  });

  it("rejects missing declared entry file", () => {
    const dir = makePkg({ "manifest.json": JSON.stringify(goodManifest()) });
    const res = validateExtensionPackage(dir);
    expect(res.ok).toBe(false);
  });

  it("rejects manifest JSON over 64KB", () => {
    const big = { ...goodManifest(), description: "x".repeat(70 * 1024) };
    const dir = makePkg({ "manifest.json": JSON.stringify(big), "run.js": "x" });
    const res = validateExtensionPackage(dir);
    expect(res.ok).toBe(false);
  });

  it("rejects secret-scan failures in metadata", () => {
    const dir = makePkg({
      "manifest.json": JSON.stringify({
        ...goodManifest(),
        metadata: { apiKey: "abc" },
      }),
      "run.js": "x",
    });
    expect(validateExtensionPackage(dir).ok).toBe(false);
  });
});
