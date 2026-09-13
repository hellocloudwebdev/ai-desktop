import { describe, expect, it } from "vitest";
import { ValidationError } from "@ai-desktop/shared";
import { ExtensionRegistry, type ExtensionRecord } from "../core/extension-registry.js";

function record(
  id = "ext-a",
  lifecycle: ExtensionRecord["lifecycle"] = "installed",
): ExtensionRecord {
  return {
    id,
    name: "Ext A",
    version: "1.0.0",
    capabilities: ["tool.register"],
    manifestHash: "hash-1",
    lifecycle,
    trust: "untrusted",
    installedAt: 1,
    updatedAt: 1,
  };
}

describe("packages/plugins: ExtensionRegistry (PR32)", () => {
  it("registers and gets a record", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    expect(r.get("ext-a")?.name).toBe("Ext A");
  });

  it("rejects duplicate registration", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    expect(() => r.register(record())).toThrow(ValidationError);
  });

  it("lists all records", () => {
    const r = new ExtensionRegistry();
    r.register(record("a"));
    r.register(record("b"));
    expect(r.list()).toHaveLength(2);
  });

  it("setLifecycle validates transitions (installed->enabled ok, installed->active throws)", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    const updated = r.setLifecycle("ext-a", "enabled");
    expect(updated.lifecycle).toBe("enabled");
    expect(() => r.setLifecycle("ext-a", "installed")).toThrow(ValidationError);
  });

  it("setLifecycle on unknown id throws", () => {
    const r = new ExtensionRegistry();
    expect(() => r.setLifecycle("ghost", "enabled")).toThrow(ValidationError);
  });

  it("enable/disable round-trip via setLifecycle", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    r.setLifecycle("ext-a", "enabled");
    r.setLifecycle("ext-a", "active");
    r.setLifecycle("ext-a", "disabled");
    r.setLifecycle("ext-a", "enabled");
    expect(r.get("ext-a")?.lifecycle).toBe("enabled");
  });

  it("setTrust updates trust state", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    r.setTrust("ext-a", "trusted");
    expect(r.get("ext-a")?.trust).toBe("trusted");
    r.setTrust("ext-a", "blocked");
    expect(r.get("ext-a")?.trust).toBe("blocked");
  });

  it("updateHash changes manifestHash", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    r.updateHash("ext-a", "hash-2");
    expect(r.get("ext-a")?.manifestHash).toBe("hash-2");
  });

  it("unregister removes the record (returns true; false when absent)", () => {
    const r = new ExtensionRegistry();
    r.register(record());
    expect(r.unregister("ext-a")).toBe(true);
    expect(r.get("ext-a")).toBeUndefined();
    expect(r.unregister("ext-a")).toBe(false);
  });
});
