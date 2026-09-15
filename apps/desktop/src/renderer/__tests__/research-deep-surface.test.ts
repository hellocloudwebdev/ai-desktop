// PR36: renderer — Deep Research Surface Tests
//
// The existing ResearchSurface renders the deep-research package view
// (sources, evidence with claim -> evidence -> source affordances,
// conflicts, citations, extractive synthesis) through the established
// surface props — no new surface kind, no raw HTML, no privileged imports.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENT = path.resolve(__dirname, "../components/workspace/surfaces/ResearchSurface.tsx");
const PROPS = path.resolve(__dirname, "../components/workspace/surfaces/surface-props.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

describe("Deep research surface contract (PR36)", () => {
  it("extends ResearchSurfaceProps with an optional package view", () => {
    const props = read(PROPS);
    expect(props).toContain("ResearchPackageView");
    expect(props).toContain("ResearchPackageEvidenceView");
    expect(props).toContain("ResearchPackageConflictView");
    expect(props).toContain("ResearchPackageCitationView");
    expect(props).toContain("deepPackage?");
    expect(props).toContain("isDeepResearching?");
    expect(props).toContain("synthesisSummary");
  });

  it("renders sources, evidence, conflicts, citations, and synthesis affordances", () => {
    const component = read(COMPONENT);
    expect(component).toContain("Deep research");
    expect(component).toContain("deepPackage");
    expect(component).toContain("isDeepResearching");
    expect(component).toContain("synthesisSummary");
    expect(component).toContain("conflicting claim");
    expect(component).toContain("onOpenResult");
  });

  it("keeps untrusted research content as plain text", () => {
    const component = read(COMPONENT);
    expect(component.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(component).not.toMatch(/from\s+["']electron["']/);
    expect(component).not.toMatch(/from\s+["']node:/);
  });

  it("bounds rendered collections with slice caps", () => {
    const component = read(COMPONENT);
    expect(component).toContain("slice(0, 10)");
    expect(component).toContain("slice(0, 5)");
  });

  it("shows running progress while deep research executes", () => {
    const component = read(COMPONENT);
    expect(component).toContain("running…");
    expect(component).toContain("status:");
  });

  it("chains evidence back to its source with an open affordance", () => {
    const component = read(COMPONENT);
    expect(component).toContain("sourceTitle");
    expect(component).toContain("sourceUrl");
  });
});
