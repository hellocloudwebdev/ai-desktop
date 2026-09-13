import { describe, expect, it } from "vitest";
import {
  EXTENSION_CAPABILITIES,
  normalizeCapabilities,
  validateCapabilities,
} from "../core/capabilities.js";

describe("packages/plugins: capabilities (PR32)", () => {
  it("exposes the closed 11-member enum", () => {
    expect(EXTENSION_CAPABILITIES).toHaveLength(11);
    expect(EXTENSION_CAPABILITIES).toContain("tool.register");
    expect(EXTENSION_CAPABILITIES).toContain("memory.read");
    expect(EXTENSION_CAPABILITIES).toContain("secrets.use");
  });

  it("normalizeCapabilities dedupes and sorts", () => {
    expect(normalizeCapabilities(["memory.read", "tool.register", "memory.read"])).toEqual([
      "memory.read",
      "tool.register",
    ]);
    expect(normalizeCapabilities([])).toEqual([]);
  });

  it("validateCapabilities returns unknown entries", () => {
    expect(validateCapabilities(["tool.register", "nope"])).toEqual(["nope"]);
    expect(validateCapabilities(["tool.register"])).toEqual([]);
    expect(validateCapabilities([])).toEqual([]);
  });

  it("validateCapabilities flags every unknown in a fully-unknown list", () => {
    expect(validateCapabilities(["x", "y"])).toEqual(["x", "y"]);
  });
});
