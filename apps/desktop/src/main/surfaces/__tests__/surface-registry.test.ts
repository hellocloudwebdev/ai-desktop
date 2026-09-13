// PR33.6: main — Surface Registry Tests

import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import { SurfaceRegistry, getSurfaceDefinitionHash } from "../surface-registry.js";

const DESCRIPTOR = {
  id: "sales-table",
  version: "1.0.0",
  kind: "table",
  title: "Sales",
};

const PROVENANCE = {
  source: "builtin",
  originId: "builtin:reports/sales",
  toolCallId: createToolCallId(),
  projectId: "proj-A",
} as const;

describe("main: SurfaceRegistry (PR33.6)", () => {
  it("registers and resolves instances with validated status", () => {
    const registry = new SurfaceRegistry();
    const instance = registry.register(DESCRIPTOR, { ...PROVENANCE });
    expect(instance.status).toBe("validated");
    expect(instance.descriptor.id).toBe("sales-table");
    expect(registry.resolve(instance.instanceId)).toEqual(instance);
    expect(registry.resolve("01JZZZZZZZZZZZZZZZZZZZZZZ" as never)).toBeUndefined();
  });

  it("enforces the strict linear lifecycle and terminal disposal", () => {
    const registry = new SurfaceRegistry();
    const instance = registry.register(DESCRIPTOR, { ...PROVENANCE });
    expect(registry.setStatus(instance.instanceId, "active")).toBe(false); // skip not allowed
    expect(registry.setStatus(instance.instanceId, "mounted")).toBe(true);
    expect(registry.setStatus(instance.instanceId, "active")).toBe(true);
    expect(registry.resolve(instance.instanceId)?.status).toBe("active");
    expect(registry.dispose(instance.instanceId)).toBe(true);
    expect(registry.setStatus(instance.instanceId, "active")).toBe(false); // terminal
    expect(registry.dispose(instance.instanceId)).toBe(true); // idempotent
  });

  it("lists by project and tool call", () => {
    const registry = new SurfaceRegistry();
    const a = registry.register(DESCRIPTOR, { ...PROVENANCE });
    const b = registry.register(
      { ...DESCRIPTOR, id: "other-doc", kind: "document" },
      { ...PROVENANCE, projectId: "proj-B", toolCallId: createToolCallId() },
    );
    expect(registry.listByProject("proj-A").map((s) => s.instanceId)).toEqual([a.instanceId]);
    expect(registry.listByProject("proj-B").map((s) => s.instanceId)).toEqual([b.instanceId]);
    expect(registry.listByToolCall(PROVENANCE.toolCallId).map((s) => s.instanceId)).toEqual([
      a.instanceId,
    ]);
  });

  it("enforces the per-toolCallId instance cap", () => {
    const registry = new SurfaceRegistry();
    for (let i = 0; i < 20; i++) {
      registry.register({ ...DESCRIPTOR, id: `table-${i}` }, { ...PROVENANCE });
    }
    expect(() => registry.register({ ...DESCRIPTOR, id: "table-20" }, { ...PROVENANCE })).toThrow(
      /cap exceeded/,
    );
  });

  it("hashes definitions deterministically and detects mutation", () => {
    const h1 = getSurfaceDefinitionHash({ id: "a", version: "1.0.0", kind: "table" });
    const h2 = getSurfaceDefinitionHash({ id: "a", version: "1.0.0", kind: "table" });
    const h3 = getSurfaceDefinitionHash({ id: "a", version: "2.0.0", kind: "table" });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("unregisters and clears", () => {
    const registry = new SurfaceRegistry();
    const instance = registry.register(DESCRIPTOR, { ...PROVENANCE });
    expect(registry.unregister(instance.instanceId)).toBe(true);
    expect(registry.unregister(instance.instanceId)).toBe(false);
    registry.register(DESCRIPTOR, { ...PROVENANCE });
    registry.clear();
    expect(registry.listByProject("proj-A")).toHaveLength(0);
  });
});
