// PR33.11: renderer — Rich Surface Store Tests
//
// Covers the additive selectedSurfaceId presentation state: the reducer
// selects/clears surface instances without disturbing the existing
// workspace-surface switch, and parseWorkspaceState round-trips the field
// (accepting strings, defaulting everything else to null).

import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_STATE, parseWorkspaceState } from "../workspace/types.js";
import { workspaceReducer } from "../workspace/store.js";

describe("renderer: rich surface selection (PR33)", () => {
  it("defaults selectedSurfaceId to null", () => {
    expect(DEFAULT_WORKSPACE_STATE.selectedSurfaceId).toBeNull();
  });

  it("selects and clears a surface instance", () => {
    const selected = workspaceReducer(DEFAULT_WORKSPACE_STATE, {
      type: "surface/select",
      surfaceId: "surf-1",
    });
    expect(selected.selectedSurfaceId).toBe("surf-1");
    // Selection is presentation-only: other state is untouched.
    expect(selected.activeSurface).toBe(DEFAULT_WORKSPACE_STATE.activeSurface);

    const cleared = workspaceReducer(selected, { type: "surface/select", surfaceId: null });
    expect(cleared.selectedSurfaceId).toBeNull();
  });

  it("keeps workspace-surface switching independent of instance selection", () => {
    const withInstance = workspaceReducer(DEFAULT_WORKSPACE_STATE, {
      type: "surface/select",
      surfaceId: "surf-1",
    });
    const switched = workspaceReducer(withInstance, { type: "surface/select", surface: "coding" });
    expect(switched.activeSurface).toBe("coding");
    expect(switched.selectedSurfaceId).toBe("surf-1");
  });

  it("parses persisted selectedSurfaceId (string or null, else null)", () => {
    expect(parseWorkspaceState({ version: 1, selectedSurfaceId: "surf-9" }).selectedSurfaceId).toBe(
      "surf-9",
    );
    expect(parseWorkspaceState({ version: 1 }).selectedSurfaceId).toBeNull();
    expect(
      parseWorkspaceState({ version: 1, selectedSurfaceId: null }).selectedSurfaceId,
    ).toBeNull();
    expect(parseWorkspaceState({ version: 1, selectedSurfaceId: 42 }).selectedSurfaceId).toBeNull();
    expect(parseWorkspaceState({ version: 1, selectedSurfaceId: "" }).selectedSurfaceId).toBeNull();
  });

  it("round-trips selection through persistence", () => {
    const selected = workspaceReducer(DEFAULT_WORKSPACE_STATE, {
      type: "surface/select",
      surfaceId: "surf-3",
    });
    const restored = parseWorkspaceState(JSON.parse(JSON.stringify(selected)) as unknown);
    expect(restored).toEqual(selected);
    expect(restored.selectedSurfaceId).toBe("surf-3");
  });
});
