// PR32: renderer — Extensions Surface + Store Tests
//
// Covers the PR32 workspace integration at presentation level: the surface
// enum accepts "extensions", stale persisted surfaces fall back to chat,
// and the bridge normalizers turn unknown IPC payloads into ExtensionViews.

import { describe, expect, it } from "vitest";
import { isWorkspaceSurface, parseWorkspaceState } from "../workspace/types.js";
import {
  normalizeExtensionInfo,
  normalizeExtensionInfos,
  unwrapExtensionList,
} from "../workspace/extensions.js";

describe("renderer: extensions surface integration (PR32)", () => {
  it("accepts extensions as a workspace surface", () => {
    expect(isWorkspaceSurface("extensions")).toBe(true);
    expect(isWorkspaceSurface("marketplace")).toBe(false);
  });

  it("stale persisted surfaces fall back to chat", () => {
    const restored = parseWorkspaceState({
      version: 1,
      activeSurface: "marketplace",
      activeProjectId: "proj-A",
    });
    expect(restored.activeSurface).toBe("chat");
    expect(restored.activeProjectId).toBe("proj-A");
  });

  it("persists and restores the extensions surface", () => {
    const restored = parseWorkspaceState({
      version: 1,
      activeSurface: "extensions",
      activeProjectId: "proj-A",
    });
    expect(restored.activeSurface).toBe("extensions");
  });

  it("normalizes extension infos and drops invalid entries", () => {
    const views = normalizeExtensionInfos([
      {
        id: "weather",
        name: "Weather",
        version: "1.0.0",
        lifecycle: "active",
        trust: "untrusted",
        manifestHash: "abc",
        installedAt: 1,
        updatedAt: 2,
        capabilities: ["tool.register"],
        enabledProjects: ["proj-A"],
      },
      { id: "", name: "bad" },
      "not-an-object",
      { id: "x", name: "y", version: "1.0.0", lifecycle: "bogus" },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.id).toBe("weather");
    expect(views[0]?.enabledProjects).toEqual(["proj-A"]);
  });

  it("normalizeExtensionInfo rejects entries without identity", () => {
    expect(normalizeExtensionInfo(null)).toBeNull();
    expect(normalizeExtensionInfo({})).toBeNull();
    expect(normalizeExtensionInfo({ id: "a", name: "b", version: "1" })).toBeNull();
  });

  it("unwrapExtensionList accepts raw arrays, envelopes, and named payloads", () => {
    expect(unwrapExtensionList([{ id: "a" }])).toHaveLength(1);
    expect(unwrapExtensionList({ ok: true, value: [{ id: "a" }] })).toHaveLength(1);
    expect(unwrapExtensionList({ ok: true, value: { extensions: [{ id: "a" }] } })).toHaveLength(1);
    expect(unwrapExtensionList({ extensions: [{ id: "a" }] })).toHaveLength(1);
    expect(unwrapExtensionList({ ok: false })).toEqual([]);
    expect(unwrapExtensionList(null)).toEqual([]);
  });
});
