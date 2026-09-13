// PR31.2: renderer — Workspace Store Tests (checkpoint before App extraction)

import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  DEFAULT_WORKSPACE_STATE,
  isWorkspaceSurface,
  parseWorkspaceState,
} from "../workspace/types.js";

describe("renderer: workspace store (PR31.2)", () => {
  it("constrains surfaces to the PR31 set", () => {
    expect(isWorkspaceSurface("chat")).toBe(true);
    expect(isWorkspaceSurface("coding")).toBe(true);
    expect(isWorkspaceSurface("tasks")).toBe(true);
    expect(isWorkspaceSurface("activity")).toBe(true);
    expect(isWorkspaceSurface("files")).toBe(true);
    expect(isWorkspaceSurface("browser")).toBe(false);
    expect(isWorkspaceSurface("")).toBe(false);
    expect(isWorkspaceSurface(undefined)).toBe(false);
  });

  it("clamps panel widths to usable bounds", () => {
    expect(clampPanelWidth("left", 50)).toBe(180);
    expect(clampPanelWidth("left", 9999)).toBe(420);
    expect(clampPanelWidth("right", 300)).toBe(300);
    expect(clampPanelWidth("left", Number.NaN)).toBe(248);
  });

  it("returns defaults on malformed or stale persisted data", () => {
    expect(parseWorkspaceState(null)).toEqual(DEFAULT_WORKSPACE_STATE);
    expect(parseWorkspaceState("garbage")).toEqual(DEFAULT_WORKSPACE_STATE);
    expect(parseWorkspaceState({ version: 2, activeSurface: "chat" })).toEqual(
      DEFAULT_WORKSPACE_STATE,
    );
    expect(parseWorkspaceState({ version: 1 })).toEqual(DEFAULT_WORKSPACE_STATE);
  });

  it("accepts valid persisted state and clamps out-of-range widths", () => {
    const parsed = parseWorkspaceState({
      version: 1,
      activeSurface: "coding",
      activeProjectId: "proj-A",
      activeConversationId: "01JM0000000000000000000001",
      activeTaskId: null,
      leftPanel: { visible: false, width: 9999 },
      rightPanel: { visible: true, width: 300 },
    });
    expect(parsed.activeSurface).toBe("coding");
    expect(parsed.activeProjectId).toBe("proj-A");
    expect(parsed.leftPanel).toEqual({ visible: false, width: 420 });
    expect(parsed.rightPanel).toEqual({ visible: true, width: 300 });
  });

  it("rejects invalid surfaces and blank projects in persisted data", () => {
    const parsed = parseWorkspaceState({
      version: 1,
      activeSurface: "hologram",
      activeProjectId: "   ",
      leftPanel: { visible: "yes", width: "wide" },
      rightPanel: null,
    });
    expect(parsed.activeSurface).toBe("chat");
    expect(parsed.activeProjectId).toBe("sample-project");
    expect(parsed.leftPanel).toEqual(DEFAULT_WORKSPACE_STATE.leftPanel);
    expect(parsed.rightPanel).toEqual(DEFAULT_WORKSPACE_STATE.rightPanel);
  });
});
