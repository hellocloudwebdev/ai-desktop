// PR34.5: renderer — Browser Surface Integration Tests
//
// Invariants tested:
//   1. "browser" is recognized as a valid WorkspaceSurface and included in WORKSPACE_SURFACES.
//   2. Persisted workspace presentation state accepts and restores "browser" surface.
//   3. BrowserSurface component contains no raw Electron or Node.js imports.
//   4. BrowserSurface component contains no dangerouslySetInnerHTML.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWorkspaceSurface, parseWorkspaceState, WORKSPACE_SURFACES } from "../workspace/types.js";

describe("Browser Surface presentation & security invariants (PR34.5)", () => {
  it("includes browser in WORKSPACE_SURFACES", () => {
    expect((WORKSPACE_SURFACES as readonly string[]).includes("browser")).toBe(true);
    expect(isWorkspaceSurface("browser")).toBe(true);
    expect(isWorkspaceSurface("non-existent-surface")).toBe(false);
  });

  it("persists and restores the browser surface in workspace state", () => {
    const state = parseWorkspaceState({
      version: 1,
      activeSurface: "browser",
      activeProjectId: "browser-test-project",
    });
    expect(state.activeSurface).toBe("browser");
    expect(state.activeProjectId).toBe("browser-test-project");
  });

  it("ensures BrowserSurface.tsx has no dangerous HTML rendering or privileged imports", () => {
    const componentPath = path.resolve(
      __dirname,
      "../components/workspace/surfaces/BrowserSurface.tsx",
    );
    const content = fs.readFileSync(componentPath, "utf-8");

    // Constitutional security rule: renderer surfaces must NEVER use dangerouslySetInnerHTML
    expect(content.includes("dangerouslySetInnerHTML")).toBe(false);

    // Architectural rule: renderer code must NEVER import electron or node:* built-ins
    expect(content).not.toMatch(/from\s+["']electron["']/);
    expect(content).not.toMatch(/from\s+["']node:/);
    expect(content).not.toMatch(/require\s*\(\s*["']electron["']\s*\)/);
    expect(content).not.toMatch(/require\s*\(\s*["']node:/);
  });
});
