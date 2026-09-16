// PR41: renderer — Coding Workspace Contract Tests
//
// Source-assertion + structural tests (no DOM): the CodingWorkspace view
// renders every panel, tracks dirty/conflict markers, handles the Ctrl+S
// save shortcut, stays free of privileged imports, and is wired through
// WorkspaceMain and App with the codingWorkspace prop.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RENDERER_SRC = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(RENDERER_SRC, relativePath), "utf8");
}

describe("renderer: coding workspace (PR41)", () => {
  it("CodingWorkspace renders the explorer panel", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "CodingWorkspace.tsx"));
    expect(src).toContain("Explorer");
    expect(src).toContain("onRefreshFiles");
    expect(src).toContain("onOpenFile");
  });

  it("CodingWorkspace renders tabs plus the editor pane", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "CodingWorkspace.tsx"));
    expect(src).toContain("onSelectTab");
    expect(src).toContain("onCloseTab");
    expect(src).toContain("textarea");
    expect(src).toContain("onEditTab");
  });

  it("CodingWorkspace renders search, terminal, diagnostics, and diff markers", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "CodingWorkspace.tsx"));
    expect(src).toContain("onSearch");
    expect(src).toContain("Project search");
    expect(src).toContain("onTerminalCreate");
    expect(src).toContain("Terminal command");
    expect(src).toContain("Problems");
    expect(src).toContain("onTerminalStop");
    expect(src).toContain("Diff:");
  });

  it("dirty tabs show an indicator and the save-shortcut handler is wired", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "CodingWorkspace.tsx"));
    expect(src).toContain("tab.dirty");
    expect(src).toContain("●");
    expect(src).toContain("ctrlKey");
    expect(src).toContain("metaKey");
    expect(src).toContain('"s"');
    expect(src).toContain("onSaveFile");
    expect(src).toContain("Save all");
  });

  it("conflict state is surfaced with revert guidance", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "CodingWorkspace.tsx"));
    expect(src).toContain("tab.conflict");
    expect(src).toContain("external change");
    expect(src).toContain("onRevertFile");
  });

  it("CodingWorkspace has no node:/electron/fs/child_process imports", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "CodingWorkspace.tsx"));
    for (const marker of [
      "node:",
      'from "electron"',
      "child_process",
      'from "fs"',
      "window.require",
    ]) {
      expect(src, marker).not.toContain(marker);
    }
  });

  it("surface-props declares CodingWorkspaceProps with dirty/conflict tabs", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "surface-props.ts"));
    expect(src).toContain("CodingWorkspaceProps");
    expect(src).toContain("WorkspaceTab");
    expect(src).toContain("dirty");
    expect(src).toContain("conflict");
    expect(src).toContain("WorkspaceDiffView");
    expect(src).toContain("WorkspaceTerminalView");
  });

  it("WorkspaceMain renders CodingWorkspace when codingWorkspace is provided", () => {
    const src = readSource(path.join("components", "workspace", "WorkspaceMain.tsx"));
    expect(src).toContain("codingWorkspace");
    expect(src).toContain("CodingWorkspace");
    expect(src).toContain("CodingSurface");
  });

  it("App passes the codingWorkspace prop into the workspace shell", () => {
    const src = readSource("App.tsx");
    expect(src).toContain("codingWorkspace={{");
    expect(src).toContain("workspaceFiles");
    expect(src).toContain("workspaceTabs");
    expect(src).toContain("onSaveFile");
  });

  it("App owns workspace state over window.api only (no privileged imports)", () => {
    const src = readSource("App.tsx");
    expect(src).toContain("window.api");
    for (const marker of ["child_process", 'from "fs"', "window.require"]) {
      expect(src, marker).not.toContain(marker);
    }
  });

  it("TaskSurfaces stays free of privileged imports", () => {
    const src = readSource(path.join("components", "workspace", "surfaces", "TaskSurfaces.tsx"));
    for (const marker of ["node:", 'from "electron"', "child_process", 'from "fs"']) {
      expect(src, marker).not.toContain(marker);
    }
  });

  it("preload exposes workspace/terminal only through the typed bridge", () => {
    const src = readSource(path.join("..", "preload", "index.ts"));
    expect(src).toContain("workspace");
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("node:fs");
  });
});
