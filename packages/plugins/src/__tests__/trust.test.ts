import { describe, expect, it } from "vitest";
import {
  computeExtensionDefinitionHash,
  trustRequiresReapproval,
  markTrustInvalidated,
} from "../core/extension-trust.js";

function manifest(caps: string[] = ["tool.register", "workspace.view"]) {
  return { id: "ext-a", version: "1.0.0", capabilities: caps, contributes: { tools: [] } };
}

describe("packages/plugins: trust (PR32)", () => {
  it("hash is stable for identical manifests", () => {
    expect(computeExtensionDefinitionHash(manifest())).toBe(
      computeExtensionDefinitionHash(manifest()),
    );
  });

  it("hash is a 64-char sha256 hex string", () => {
    expect(computeExtensionDefinitionHash(manifest())).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hash changes when capabilities change", () => {
    const before = computeExtensionDefinitionHash(manifest());
    const after = computeExtensionDefinitionHash(manifest(["tool.register"]));
    expect(before).not.toBe(after);
  });

  it("hash changes when version changes", () => {
    const a = computeExtensionDefinitionHash(manifest());
    const b = computeExtensionDefinitionHash({ ...manifest(), version: "2.0.0" });
    expect(a).not.toBe(b);
  });

  it("hash is order-insensitive for capabilities (sorted before hashing)", () => {
    const a = computeExtensionDefinitionHash(manifest(["workspace.view", "tool.register"]));
    const b = computeExtensionDefinitionHash(manifest(["tool.register", "workspace.view"]));
    expect(a).toBe(b);
  });

  it("trustRequiresReapproval flags changed hashes only", () => {
    const h1 = computeExtensionDefinitionHash(manifest());
    const h2 = computeExtensionDefinitionHash(manifest(["tool.register"]));
    expect(trustRequiresReapproval(h1, h1)).toBe(false);
    expect(trustRequiresReapproval(h1, h2)).toBe(true);
  });

  it("markTrustInvalidated downgrades trusted->untrusted, keeps blocked/untrusted", () => {
    expect(markTrustInvalidated("trusted")).toBe("untrusted");
    expect(markTrustInvalidated("blocked")).toBe("blocked");
    expect(markTrustInvalidated("untrusted")).toBe("untrusted");
  });
});
