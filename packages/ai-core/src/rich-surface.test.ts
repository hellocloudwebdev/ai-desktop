// PR33: packages/ai-core — Rich-Surface Contract Tests

import { describe, expect, it } from "vitest";
import { createToolCallId } from "@ai-desktop/shared";
import {
  RENDERABLE_KINDS,
  SURFACE_KINDS,
  SurfaceInstanceSchema,
  SurfaceProvenanceSchema,
  SurfaceStatusSchema,
  RichSurfaceDescriptorSchema,
  asSurfaceInstanceId,
  createSurfaceInstanceId,
  extractSurfaceDescriptor,
  isSafeSurfacePath,
  isSafeSurfaceUrl,
  parseSurfaceInstanceId,
  validateSurfaceAction,
  validateSurfaceDescriptor,
} from "./rich-surface.js";

function validDescriptor(kind: string = "document") {
  return {
    id: "surface.doc-1",
    version: "1.0.0",
    kind,
    title: "Sample surface",
  };
}

describe("packages/ai-core: Rich-surface contracts (PR33)", () => {
  it("accepts valid document/table/form descriptors", () => {
    for (const kind of ["document", "table", "form"] as const) {
      const parsed = validateSurfaceDescriptor(validDescriptor(kind));
      expect(parsed.kind).toBe(kind);
      expect(parsed.id).toBe("surface.doc-1");
      expect(parsed.dataSchema).toEqual({});
    }
    expect(SURFACE_KINDS).toContain("chart");
    expect(SURFACE_KINDS).toContain("application");
    expect(RENDERABLE_KINDS).toEqual(["document", "table", "form"]);
  });

  it("rejects unknown kinds and bad SemVer versions", () => {
    expect(() => validateSurfaceDescriptor(validDescriptor("bogus"))).toThrow();
    expect(() => validateSurfaceDescriptor({ ...validDescriptor(), version: "1.0" })).toThrow(
      /SemVer/,
    );
    expect(() => validateSurfaceDescriptor({ ...validDescriptor(), version: "v1.0.0" })).toThrow(
      /SemVer/,
    );
    expect(() => validateSurfaceDescriptor({ ...validDescriptor(), version: "1.0.0.0" })).toThrow(
      /SemVer/,
    );
  });

  it("rejects oversized titles", () => {
    expect(() =>
      validateSurfaceDescriptor({ ...validDescriptor(), title: "x".repeat(201) }),
    ).toThrow();
  });

  it("round-trips SurfaceInstanceId create/parse and rejects non-ULIDs", () => {
    const created = createSurfaceInstanceId();
    expect(parseSurfaceInstanceId(created)).toBe(created);
    expect(asSurfaceInstanceId(created)).toBe(created);
    expect(() => parseSurfaceInstanceId("not-a-ulid")).toThrow(TypeError);
  });

  it("rejects unknown lifecycle status values at the schema level", () => {
    for (const status of ["declared", "validated", "mounted", "active", "disposed"]) {
      expect(SurfaceStatusSchema.parse(status)).toBe(status);
    }
    expect(() => SurfaceStatusSchema.parse("archived")).toThrow();
  });

  it("accepts full surface instances with provenance and timestamps", () => {
    const parsed = SurfaceInstanceSchema.parse({
      instanceId: createSurfaceInstanceId(),
      descriptor: validDescriptor("table"),
      provenance: {
        source: "builtin",
        originId: "origin-1",
        toolCallId: createToolCallId(),
      },
      status: "declared",
      createdAt: "2026-09-13T00:00:00.000Z",
    });
    expect(parsed.status).toBe("declared");
    expect(parsed.provenance.source).toBe("builtin");
  });

  it("rejects dangerous URL schemes and accepts safe URLs", () => {
    expect(isSafeSurfaceUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeSurfaceUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeSurfaceUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeSurfaceUrl("https://example.com/x")).toBe(true);
    expect(isSafeSurfaceUrl("/relative/path")).toBe(true);
  });

  it("rejects traversal paths and accepts plain relative paths", () => {
    expect(isSafeSurfacePath("../escape")).toBe(false);
    expect(isSafeSurfacePath("a/../../b")).toBe(false);
    expect(isSafeSurfacePath("src/a.ts")).toBe(true);
  });

  it("extracts stamped descriptors and returns null for invalid metadata", () => {
    const descriptor = validateSurfaceDescriptor(validDescriptor());
    expect(extractSurfaceDescriptor({ surface: validDescriptor() })).toEqual({
      ...descriptor,
      dataSchema: {},
    });
    expect(extractSurfaceDescriptor({})).toBeNull();
    expect(extractSurfaceDescriptor(null)).toBeNull();
    expect(extractSurfaceDescriptor({ surface: { kind: "bogus" } })).toBeNull();
  });

  it("requires toolCallId in provenance", () => {
    expect(() =>
      SurfaceProvenanceSchema.parse({ source: "builtin", originId: "origin-1" }),
    ).toThrow();
    const toolCallId = createToolCallId();
    const parsed = SurfaceProvenanceSchema.parse({
      source: "mcp",
      originId: "origin-1",
      toolCallId,
    });
    expect(parsed.toolCallId).toBe(toolCallId);
  });

  it("validates surface actions and rejects malformed input", () => {
    const action = validateSurfaceAction({
      actionId: "form.submit-1",
      type: "submit",
      toolName: "builtin:forms.submit",
    });
    expect(action.type).toBe("submit");
    expect(action.inputSchema).toEqual({});
    expect(() =>
      validateSurfaceAction({ actionId: "a1", type: "explode", toolName: "t" }),
    ).toThrow();
    expect(() => RichSurfaceDescriptorSchema.parse(validDescriptor("chart"))).not.toThrow();
  });
});
