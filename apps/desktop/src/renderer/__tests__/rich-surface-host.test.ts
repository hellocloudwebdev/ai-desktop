// PR33.10: renderer — Rich Surface Host Tests (node-safe)
//
// Covers the PR33 presentation layer without a DOM: pure guard helpers
// (href safety, row caps, cell coercion, form validation), the surface
// bridge normalizers, and static source scans proving the surface
// components introduce no inner-HTML sinks, no unsafe URL schemes, and no
// Node/Electron/window.api imports.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  coerceCell,
  isSafeHref,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  truncateColumns,
  truncateRows,
  validateFormValues,
} from "../components/workspace/surfaces/surface-guards.js";
import {
  normalizeSurfaceView,
  normalizeSurfaceViews,
  unwrapSurfaceList,
} from "../workspace/surfaces.js";

const RENDERER_SRC = path.join(__dirname, "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(RENDERER_SRC, relativePath), "utf8");
}

const SURFACE_SOURCES = [
  "components/workspace/surfaces/RichSurfaceHost.tsx",
  "components/workspace/surfaces/DocumentSurface.tsx",
  "components/workspace/surfaces/TableSurface.tsx",
  "components/workspace/surfaces/FormSurface.tsx",
];

describe("renderer: surface href safety (PR33)", () => {
  it("accepts http/https, fragments, and relative hrefs", () => {
    expect(isSafeHref("https://example.com/a?b=1")).toBe(true);
    expect(isSafeHref("http://localhost:3000/x")).toBe(true);
    expect(isSafeHref("#section-2")).toBe(true);
    expect(isSafeHref("/docs/guide")).toBe(true);
    expect(isSafeHref("./relative/path")).toBe(true);
    expect(isSafeHref("../up/one")).toBe(true);
  });

  it("rejects executable and exotic schemes", () => {
    for (const href of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "  javascript:void(0)",
      "data:text/html,<h1>x</h1>",
      "DATA:text/plain,hi",
      "vbscript:msgbox(1)",
      "VBScript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/uuid",
    ]) {
      expect(href, href).toSatisfy(() => !isSafeHref(href));
    }
  });

  it("rejects traversal-ish and non-link inputs", () => {
    expect(isSafeHref("")).toBe(false);
    expect(isSafeHref("   ")).toBe(false);
    expect(isSafeHref(null)).toBe(false);
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref(42)).toBe(false);
    expect(isSafeHref("example.com/no-scheme")).toBe(false);
    expect(isSafeHref("mailto:a@b.c")).toBe(false);
    expect(isSafeHref("ftp://files/x")).toBe(false);
  });
});

describe("renderer: table shaping helpers (PR33)", () => {
  it("exposes the contract caps", () => {
    expect(MAX_TABLE_COLUMNS).toBe(50);
    expect(MAX_TABLE_ROWS).toBe(500);
  });

  it("passes short row lists through untouched", () => {
    const rows = [["a"], ["b"]];
    const view = truncateRows(rows, 500);
    expect(view.rows).toHaveLength(2);
    expect(view.truncated).toBe(false);
    expect(view.total).toBe(2);
  });

  it("caps rows at the max with a truncation flag", () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`r${i}`]);
    const view = truncateRows(rows, MAX_TABLE_ROWS);
    expect(view.rows).toHaveLength(500);
    expect(view.truncated).toBe(true);
    expect(view.total).toBe(600);
  });

  it("caps columns at 50", () => {
    const columns = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const view = truncateColumns(columns);
    expect(view.rows).toHaveLength(50);
    expect(view.truncated).toBe(true);
    expect(view.total).toBe(60);
  });

  it("coerces cells to display text", () => {
    expect(coerceCell("hi")).toBe("hi");
    expect(coerceCell(42)).toBe("42");
    expect(coerceCell(0)).toBe("0");
    expect(coerceCell(true)).toBe("true");
    expect(coerceCell(false)).toBe("false");
    expect(coerceCell(null)).toBe("");
    expect(coerceCell(undefined)).toBe("");
    expect(coerceCell({ a: 1 })).toBe('{"a":1}');
    expect(coerceCell([1, 2])).toBe("[1,2]");
  });
});

describe("renderer: form validation (PR33)", () => {
  const fields = [
    { id: "name", label: "Name", type: "text" as const, required: true },
    { id: "age", label: "Age", type: "number" as const },
    { id: "color", label: "Color", type: "select" as const, options: ["red", "blue"] },
  ];

  it("passes when required fields are present", () => {
    const result = validateFormValues(fields, { name: "Ada", age: 36, color: "red" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
  });

  it("flags missing or blank required fields", () => {
    expect(validateFormValues(fields, {}).errors).toHaveProperty("name");
    expect(validateFormValues(fields, { name: "   " }).errors).toHaveProperty("name");
    const result = validateFormValues(fields, { name: "Ada" });
    expect(result.ok).toBe(true);
  });

  it("rejects non-numeric numbers and off-list select values", () => {
    const badNumber = validateFormValues(fields, { name: "Ada", age: "old" });
    expect(badNumber.ok).toBe(false);
    expect(badNumber.errors).toHaveProperty("age");
    const okNumericString = validateFormValues(fields, { name: "Ada", age: "36" });
    expect(okNumericString.errors).not.toHaveProperty("age");
    const badSelect = validateFormValues(fields, { name: "Ada", color: "green" });
    expect(badSelect.ok).toBe(false);
    expect(badSelect.errors).toHaveProperty("color");
  });
});

describe("renderer: surface bridge normalizers (PR33)", () => {
  it("normalizes valid surface views and drops invalid entries", () => {
    const views = normalizeSurfaceViews([
      {
        instanceId: "surf-1",
        kind: "document",
        title: "Notes",
        status: "ready",
        provenance: { source: "agent", originId: "task-1", projectId: "proj-A" },
        data: { blocks: [] },
        actions: [{ actionId: "a1", type: "open", toolName: "surface.open", title: "Open" }],
      },
      { instanceId: "", kind: "table" },
      "not-an-object",
      { instanceId: "x", kind: "form", status: "ready" },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.instanceId).toBe("surf-1");
    expect(views[0]?.provenance.projectId).toBe("proj-A");
    expect(views[0]?.actions).toHaveLength(1);
  });

  it("normalizeSurfaceView requires provenance identity", () => {
    expect(normalizeSurfaceView(null)).toBeNull();
    expect(normalizeSurfaceView({})).toBeNull();
    expect(normalizeSurfaceView({ instanceId: "a", kind: "document", status: "ready" })).toBeNull();
    expect(
      normalizeSurfaceView({
        instanceId: "a",
        kind: "document",
        status: "ready",
        provenance: { source: "agent" },
      }),
    ).toBeNull();
  });

  it("unwrapSurfaceList accepts raw arrays, envelopes, and named payloads", () => {
    expect(unwrapSurfaceList([{ instanceId: "a" }])).toHaveLength(1);
    expect(unwrapSurfaceList({ ok: true, value: [{ instanceId: "a" }] })).toHaveLength(1);
    expect(
      unwrapSurfaceList({ ok: true, value: { surfaces: [{ instanceId: "a" }] } }),
    ).toHaveLength(1);
    expect(unwrapSurfaceList({ surfaces: [{ instanceId: "a" }] })).toHaveLength(1);
    expect(unwrapSurfaceList({ ok: false })).toEqual([]);
    expect(unwrapSurfaceList(null)).toEqual([]);
  });
});

describe("renderer: surface static safety (PR33)", () => {
  it("surface components never use inner-HTML sinks", () => {
    for (const file of SURFACE_SOURCES) {
      expect(readSource(file), file).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("surface components never embed executable URL schemes", () => {
    for (const file of SURFACE_SOURCES) {
      const source = readSource(file).toLowerCase();
      expect(source, file).not.toContain("javascript:");
      expect(source, file).not.toContain("vbscript:");
    }
  });

  it("surface components import only React + local types (no node/electron/ipc)", () => {
    for (const file of SURFACE_SOURCES) {
      const source = readSource(file);
      expect(source, file).not.toContain("window.api");
      expect(source, file).not.toContain("node:");
      expect(source, file).not.toContain('from "electron"');
      expect(source, file).not.toContain('from "fs"');
      expect(source, file).not.toContain('from "path"');
    }
  });

  it("RichSurfaceHost wraps each kind in the existing error boundary", () => {
    const host = readSource("components/workspace/surfaces/RichSurfaceHost.tsx");
    expect(host).toContain("WorkspaceErrorBoundary");
    expect(host).toContain("../WorkspaceErrorBoundary.js");
    expect(host).toContain("not rendered in PR33");
  });

  it("document links validate hrefs and render unsafe links as text", () => {
    const document = readSource("components/workspace/surfaces/DocumentSurface.tsx");
    expect(document).toContain("isSafeHref");
    expect(document).not.toContain("dangerouslySetInnerHTML");
  });
});
