// PR35: renderer — Research Surface Integration Tests
//
// Invariants tested:
//   1. "research" is recognized as a valid WorkspaceSurface and included in WORKSPACE_SURFACES.
//   2. Persisted workspace presentation state accepts and restores "research" surface.
//   3. ResearchSurface component contains no raw Electron or Node.js imports.
//   4. ResearchSurface component contains no dangerouslySetInnerHTML (untrusted
//      web content is rendered as plain text only).
//   5. ResearchSurface renders provenance (provider) affordances.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWorkspaceSurface, parseWorkspaceState, WORKSPACE_SURFACES } from "../workspace/types.js";

describe("Research Surface presentation & security invariants (PR35)", () => {
  it("includes research in WORKSPACE_SURFACES", () => {
    expect((WORKSPACE_SURFACES as readonly string[]).includes("research")).toBe(true);
    expect(isWorkspaceSurface("research")).toBe(true);
    expect(isWorkspaceSurface("non-existent-surface")).toBe(false);
  });

  it("persists and restores the research surface in workspace state", () => {
    const state = parseWorkspaceState({
      version: 1,
      activeSurface: "research",
      activeProjectId: "research-test-project",
    });
    expect(state.activeSurface).toBe("research");
    expect(state.activeProjectId).toBe("research-test-project");
  });

  it("ensures ResearchSurface.tsx has no dangerous HTML rendering or privileged imports", () => {
    const componentPath = path.resolve(
      __dirname,
      "../components/workspace/surfaces/ResearchSurface.tsx",
    );
    const content = fs.readFileSync(componentPath, "utf-8");

    // Untrusted web content must render as text — never raw HTML.
    expect(content.includes("dangerouslySetInnerHTML")).toBe(false);

    // Architectural rule: renderer code must NEVER import electron or node:* built-ins
    expect(content).not.toMatch(/from\s+["']electron["']/);
    expect(content).not.toMatch(/from\s+["']node:/);
    expect(content).not.toMatch(/require\s*\(\s*["']electron["']\s*\)/);
    expect(content).not.toMatch(/require\s*\(\s*["']node:/);
  });

  it("renders result provenance affordances (provider, open, browser handoff)", () => {
    const componentPath = path.resolve(
      __dirname,
      "../components/workspace/surfaces/ResearchSurface.tsx",
    );
    const content = fs.readFileSync(componentPath, "utf-8");
    expect(content).toContain("provider");
    expect(content).toContain("onOpenResult");
    expect(content).toContain("onOpenInBrowser");
    expect(content).toContain("Research query");
  });
});
