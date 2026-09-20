// apps/desktop — Production smoke check tests.

import { describe, expect, it } from "vitest";
import { runProductionSmokeChecks } from "./smoke.js";

function healthyDeps() {
  return {
    storage: { ping: () => Promise.resolve(true) },
    permissionManager: { check: () => Promise.resolve({ ok: true }) },
  };
}

describe("release: smoke checks", () => {
  it("passes all four checks in order when dependencies are healthy", async () => {
    const results = await runProductionSmokeChecks(healthyDeps());
    expect(results.map((result) => result.name)).toEqual([
      "launch",
      "storage",
      "permissions",
      "persistence",
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results).toHaveLength(4);
  });

  it("marks storage and persistence failed when the ping is false", async () => {
    const results = await runProductionSmokeChecks({
      ...healthyDeps(),
      storage: { ping: () => Promise.resolve(false) },
    });
    const byName = Object.fromEntries(results.map((result) => [result.name, result]));
    expect(byName.launch.ok).toBe(true);
    expect(byName.storage.ok).toBe(false);
    expect(byName.persistence.ok).toBe(false);
    expect(byName.permissions.ok).toBe(true);
    expect(typeof byName.storage.detail).toBe("string");
  });

  it("never throws when probes reject or dependencies are missing", async () => {
    const rejected = await runProductionSmokeChecks({
      storage: {
        ping: () => Promise.reject(new Error("db offline")),
      },
      permissionManager: {
        check: () => Promise.reject(new Error("denied")),
      },
    });
    expect(rejected).toHaveLength(4);
    expect(rejected.every((result) => typeof result.ok === "boolean")).toBe(true);

    const missing = await runProductionSmokeChecks({});
    expect(missing).toHaveLength(4);
    expect(missing[0].ok).toBe(true);
    expect(missing.slice(1).every((result) => result.ok === false)).toBe(true);
  });

  it("redacts secret material from failure details", async () => {
    const results = await runProductionSmokeChecks({
      storage: {
        ping: () =>
          Promise.reject(new Error("connection failed apiKey=sk-ant-secretvalue1234567890")),
      },
    });
    const storage = results.find((result) => result.name === "storage");
    expect(storage?.ok).toBe(false);
    expect(storage?.detail).toBeDefined();
    expect(storage?.detail ?? "").not.toContain("sk-ant-secretvalue1234567890");
    expect(storage?.detail ?? "").not.toContain("sk-ant-");
  });
});
