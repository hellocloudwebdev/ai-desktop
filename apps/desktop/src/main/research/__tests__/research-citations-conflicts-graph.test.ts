// PR36: apps/desktop — Citations, Conflicts, Source Graph Tests

import { describe, expect, it } from "vitest";
import {
  createResearchCitationId,
  createResearchClaimId,
  createResearchEvidenceId,
  createResearchSourceId,
} from "@ai-desktop/ai-core";
import { ValidationError } from "@ai-desktop/shared";
import { buildResearchCitations, verifyCitationIntegrity } from "../research-citations.js";
import { createResearchConflict, detectNumericConflicts } from "../research-conflicts.js";
import { ResearchSourceGraph } from "../research-source-graph.js";

const STAMP = "2026-09-15T00:00:00.000Z";

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: createResearchSourceId(),
    canonicalUrl: "https://example.com/article",
    rawUrls: ["https://example.com/article"],
    title: "Article",
    domain: "example.com",
    publisher: "Example",
    sourceType: "blog" as const,
    providers: ["test-search"],
    firstRetrievedAt: STAMP,
    lastRetrievedAt: STAMP,
    ...overrides,
  };
}

describe("buildResearchCitations", () => {
  it("cites only sources that contributed evidence", () => {
    const a = source({ canonicalUrl: "https://example.com/a" });
    const b = source({ canonicalUrl: "https://example.com/b" });
    const evidence = [
      {
        evidenceId: createResearchEvidenceId(),
        sourceId: a.sourceId,
        excerpt: "hello world",
        retrievedAt: STAMP,
      },
    ];
    const citations = buildResearchCitations([a, b], evidence);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.sourceId).toBe(a.sourceId);
    expect(citations[0]?.url).toBe("https://example.com/a");
  });

  it("passes the first evidence locator through", () => {
    const a = source();
    const evidence = [
      {
        evidenceId: createResearchEvidenceId(),
        sourceId: a.sourceId,
        excerpt: "hello world",
        locator: { kind: "paragraph" as const, value: "paragraph-2" },
        retrievedAt: STAMP,
      },
    ];
    const citations = buildResearchCitations([a], evidence);
    expect(citations[0]?.locator).toEqual({ kind: "paragraph", value: "paragraph-2" });
  });

  it("returns [] when no evidence exists", () => {
    expect(buildResearchCitations([source()], [])).toEqual([]);
  });
});

describe("verifyCitationIntegrity", () => {
  function chain() {
    const s = source();
    const e = {
      evidenceId: createResearchEvidenceId(),
      sourceId: s.sourceId,
      excerpt: "hello",
      retrievedAt: STAMP,
    };
    const claim = {
      claimId: createResearchClaimId(),
      text: "hello",
      evidenceIds: [e.evidenceId],
      sourceIds: [s.sourceId],
    };
    const citation = {
      citationId: createResearchCitationId(),
      sourceId: s.sourceId,
      url: s.canonicalUrl,
      retrievedAt: STAMP,
    };
    return { s, e, claim, citation };
  }

  it("reports ok for a clean chain", () => {
    const { s, e, claim, citation } = chain();
    expect(
      verifyCitationIntegrity({
        sources: [s],
        evidence: [e],
        claims: [claim],
        citations: [citation],
      }).ok,
    ).toBe(true);
  });

  it("flags dangling citation sources", () => {
    const { s, e, claim, citation } = chain();
    const report = verifyCitationIntegrity({
      sources: [],
      evidence: [e],
      claims: [claim],
      citations: [{ ...citation }],
    });
    expect(report.ok).toBe(false);
    expect(report.danglingCitationSourceIds).toContain(s.sourceId);
    expect(report.danglingEvidenceSourceIds).toContain(s.sourceId);
  });

  it("flags dangling claim evidence and sources", () => {
    const { s, e, citation } = chain();
    const report = verifyCitationIntegrity({
      sources: [s],
      evidence: [],
      claims: [
        {
          claimId: createResearchClaimId(),
          text: "x",
          evidenceIds: [e.evidenceId],
          sourceIds: [s.sourceId],
        },
      ],
      citations: [citation],
    });
    expect(report.danglingClaimEvidenceIds).toContain(e.evidenceId);
  });
});

describe("detectNumericConflicts", () => {
  it("detects 100M vs 80M users as one conflict", () => {
    const conflicts = detectNumericConflicts([
      { evidenceId: "e1", sourceId: "s1", excerpt: "The service has 100M users worldwide." },
      { evidenceId: "e2", sourceId: "s2", excerpt: "Reports put the base at 80M users." },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.topic).toContain("million");
    const texts = [conflicts[0]?.claimA.text, conflicts[0]?.claimB.text].join(" ");
    expect(texts).toContain("100M");
    expect(texts).toContain("80M");
  });

  it("ignores equal values and single-source groups", () => {
    expect(
      detectNumericConflicts([
        { evidenceId: "e1", sourceId: "s1", excerpt: "100M users." },
        { evidenceId: "e2", sourceId: "s2", excerpt: "100M users." },
      ]),
    ).toEqual([]);
    expect(
      detectNumericConflicts([
        { evidenceId: "e1", sourceId: "s1", excerpt: "100M users then 80M users." },
      ]),
    ).toEqual([]);
  });

  it("merges % with percent", () => {
    const conflicts = detectNumericConflicts([
      { evidenceId: "e1", sourceId: "s1", excerpt: "Adoption is at 40%." },
      { evidenceId: "e2", sourceId: "s2", excerpt: "Adoption is at 55 percent." },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.topic).toContain("percent");
  });

  it("merges $ with USD", () => {
    const conflicts = detectNumericConflicts([
      { evidenceId: "e1", sourceId: "s1", excerpt: "Priced at $20 per seat." },
      { evidenceId: "e2", sourceId: "s2", excerpt: "Priced at 25 USD per seat." },
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("orders conflicts deterministically by unit", () => {
    const items = [
      { evidenceId: "e1", sourceId: "s1", excerpt: "90M users and $10." },
      { evidenceId: "e2", sourceId: "s2", excerpt: "80M users and $20." },
    ];
    const first = detectNumericConflicts(items).map((c) => c.topic);
    const second = detectNumericConflicts([...items].reverse()).map((c) => c.topic);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });

  it("createResearchConflict builds a two-sided conflict", () => {
    const conflict = createResearchConflict(
      "topic",
      { text: "a", claimIds: ["c1"], evidenceIds: ["e1"], sourceIds: ["s1"] },
      { text: "b", claimIds: ["c2"], evidenceIds: ["e2"], sourceIds: ["s2"] },
    );
    expect(conflict.claimA.text).toBe("a");
    expect(conflict.claimB.text).toBe("b");
  });
});

describe("ResearchSourceGraph", () => {
  it("records duplicate, cite, support, and contradict edges", () => {
    const graph = new ResearchSourceGraph();
    graph.addSource("s1", { canonicalUrl: "https://example.com/a" });
    graph.addSource("s2");
    graph.addDuplicateEdge("s1", "s2");
    graph.addCitesEdge("s2", "s1");
    graph.addClaimSupport("claim-1", "s1");
    graph.addClaimContradiction("claim-1", "s2");
    const json = graph.toJSON();
    expect(json.nodes).toHaveLength(3);
    expect(json.edges.map((e) => e.relation).sort()).toEqual([
      "cites",
      "contradicts",
      "duplicates",
      "supports",
    ]);
    expect(json.nodes.find((n) => n.id === "claim-1")?.kind).toBe("claim");
  });

  it("throws when node or edge budgets are exceeded", () => {
    const nodes = new ResearchSourceGraph({ maxNodes: 1 });
    nodes.addSource("s1");
    expect(() => nodes.addSource("s2")).toThrow(ValidationError);

    const edges = new ResearchSourceGraph({ maxEdges: 1 });
    edges.addDuplicateEdge("a", "b");
    expect(() => edges.addDuplicateEdge("a", "b")).toThrow(ValidationError);
  });

  it("rejects empty source ids", () => {
    expect(() => new ResearchSourceGraph().addSource("")).toThrow(ValidationError);
  });
});
