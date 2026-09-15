// PR35.28/35.30: renderer — Research Surface Tests
//
// Covers workspace registration ("research" surface, sidebar tab, main
// switch), state persistence, and the renderer security invariants
// (no raw HTML rendering, no Electron/Node imports). Follows the
// PR34.5 browser-surface test precedent.

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

  it("registers the research tab in the sidebar and the main switch", () => {
    const sidebar = fs.readFileSync(
      path.resolve(__dirname, "../components/workspace/WorkspaceSidebar.tsx"),
      "utf-8",
    );
    expect(sidebar).toContain('{ id: "research", label: "Research" }');

    const main = fs.readFileSync(
      path.resolve(__dirname, "../components/workspace/WorkspaceMain.tsx"),
      "utf-8",
    );
    expect(main).toContain("ResearchSurface");
    expect(main).toContain('surface === "research"');
  });

  it("ensures ResearchSurface.tsx has no dangerous HTML rendering or privileged imports", () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, "../components/workspace/surfaces/ResearchSurface.tsx"),
      "utf-8",
    );
    expect(content.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(content).not.toMatch(/from\s+["']electron["']/);
    expect(content).not.toMatch(/from\s+["']node:/);
    expect(content).not.toMatch(/require\s*\(\s*["']electron["']\s*\)/);
    expect(content).not.toMatch(/require\s*\(\s*["']node:/);
  });

  it("exposes search/open affordances through the preload bridge", () => {
    const preload = fs.readFileSync(path.resolve(__dirname, "../../preload/index.ts"), "utf-8");
    expect(preload).toContain("searchResearch");
    expect(preload).toContain("openResearch");
    expect(preload).toContain("RESEARCH_SEARCH");
    expect(preload).toContain("RESEARCH_OPEN");
  });
});
