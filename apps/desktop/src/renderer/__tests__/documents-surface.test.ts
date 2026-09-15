// PR37: renderer — Documents Surface Tests
//
// The existing Files surface renders project documents (metadata, status,
// bounded plain-text preview) through established props — no new surface
// kind, no raw HTML, no privileged imports; document commands travel via
// the typed window.api bridge.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TASK_SURFACES = path.resolve(__dirname, "../components/workspace/surfaces/TaskSurfaces.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");
const PRELOAD = path.resolve(__dirname, "../../preload/index.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

describe("Documents surface contract (PR37)", () => {
  it("extends FilesSurfaceProps with optional document views", () => {
    const props = read(PROPS);
    expect(props).toContain("DocumentFileView");
    expect(props).toContain("SelectedDocumentView");
    expect(props).toContain("documents?");
    expect(props).toContain("selectedDocument?");
    expect(props).toContain("onSelectDocument?");
  });

  it("renders documents section with metadata and preview affordances", () => {
    const component = read(TASK_SURFACES);
    expect(component).toContain("Documents:");
    expect(component).toContain("selectedDocument");
    expect(component).toContain("onSelectDocument");
    expect(component).toContain("Close preview");
  });

  it("keeps document content as plain text", () => {
    const component = read(TASK_SURFACES);
    expect(component.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(component).not.toMatch(/from\s+["']electron["']/);
    expect(component).not.toMatch(/from\s+["']node:/);
  });

  it("exposes typed window.api document commands", () => {
    const preload = read(PRELOAD);
    expect(preload).toContain("listDocuments");
    expect(preload).toContain("getDocument");
    expect(preload).toContain("searchDocuments");
    expect(preload).toContain("ingestDocument");
    expect(preload).toContain("deleteDocument");
  });
});
