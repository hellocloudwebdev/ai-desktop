// PR31: renderer — Workspace Layout + Navigation Tests
//
// Pure presentation logic: store transitions (reducer-level behavior is
// covered by workspace-store.test.ts; these prove the composed contract the
// shell depends on: defaults, surface switching, panel collapse/width,
// project-switch isolation, and persisted-state restoration).

import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  DEFAULT_WORKSPACE_STATE,
  parseWorkspaceState,
  WORKSPACE_PANEL_LIMITS,
  type WorkspacePresentationState,
} from "../workspace/types.js";
import { workspaceReducer } from "../workspace/store.js";

describe("renderer: workspace layout + navigation (PR31)", () => {
  it("renders three columns by default (both panels visible)", () => {
    expect(DEFAULT_WORKSPACE_STATE.leftPanel.visible).toBe(true);
    expect(DEFAULT_WORKSPACE_STATE.rightPanel.visible).toBe(true);
    expect(DEFAULT_WORKSPACE_STATE.activeSurface).toBe("chat");
  });

  it("collapses panels independently without losing widths", () => {
    const collapsed = {
      ...DEFAULT_WORKSPACE_STATE,
      leftPanel: { ...DEFAULT_WORKSPACE_STATE.leftPanel, visible: false },
    };
    expect(collapsed.leftPanel.visible).toBe(false);
    expect(collapsed.leftPanel.width).toBe(DEFAULT_WORKSPACE_STATE.leftPanel.width);
    expect(collapsed.rightPanel.visible).toBe(true);
  });

  it("clamps widths to usable bounds on resize", () => {
    expect(clampPanelWidth("left", WORKSPACE_PANEL_LIMITS.left.min - 100)).toBe(
      WORKSPACE_PANEL_LIMITS.left.min,
    );
    expect(clampPanelWidth("right", WORKSPACE_PANEL_LIMITS.right.max + 100)).toBe(
      WORKSPACE_PANEL_LIMITS.right.max,
    );
  });

  it("switches surfaces without touching selection state", () => {
    const withSelection: WorkspacePresentationState = {
      ...DEFAULT_WORKSPACE_STATE,
      activeConversationId: "01JM0000000000000000000001",
      activeTaskId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const switched = workspaceReducer(withSelection, { type: "surface/select", surface: "coding" });
    expect(switched.activeSurface).toBe("coding");
    expect(switched.activeConversationId).toBe("01JM0000000000000000000001");
    expect(switched.activeTaskId).toBe("01JAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("restores layout + project + conversation from persisted state", () => {
    const restored = parseWorkspaceState({
      version: 1,
      activeSurface: "tasks",
      activeProjectId: "proj-A",
      activeConversationId: "01JM0000000000000000000001",
      activeTaskId: null,
      leftPanel: { visible: false, width: 300 },
      rightPanel: { visible: true, width: 360 },
    });
    expect(restored.activeSurface).toBe("tasks");
    expect(restored.activeProjectId).toBe("proj-A");
    expect(restored.activeConversationId).toBe("01JM0000000000000000000001");
    expect(restored.leftPanel).toEqual({ visible: false, width: 300 });
    expect(restored.rightPanel).toEqual({ visible: true, width: 360 });
  });

  it("project switch clears task selection (isolation visible)", () => {
    // Real reducer rule: selecting a project resets activeTaskId so Project A
    // task context never silently persists under Project B.
    const before: WorkspacePresentationState = {
      ...DEFAULT_WORKSPACE_STATE,
      activeProjectId: "proj-A",
      activeTaskId: "01JAAAAAAAAAAAAAAAAAAAAAAAAA",
    };
    const after = workspaceReducer(before, { type: "project/select", projectId: "proj-B" });
    expect(after.activeProjectId).toBe("proj-B");
    expect(after.activeTaskId).toBeNull();
    expect(parseWorkspaceState(JSON.parse(JSON.stringify(after)))).toEqual(after);
  });

  it("panel toggle and width transitions preserve the other panel", () => {
    const toggled = workspaceReducer(DEFAULT_WORKSPACE_STATE, {
      type: "panel/toggle",
      panel: "left",
    });
    expect(toggled.leftPanel.visible).toBe(false);
    expect(toggled.leftPanel.width).toBe(DEFAULT_WORKSPACE_STATE.leftPanel.width);
    const resized = workspaceReducer(toggled, {
      type: "panel/setWidth",
      panel: "right",
      width: 9999,
    });
    expect(resized.rightPanel.width).toBe(WORKSPACE_PANEL_LIMITS.right.max);
    expect(resized.leftPanel.visible).toBe(false);
  });
});
