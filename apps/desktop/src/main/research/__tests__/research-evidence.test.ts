// PR36: apps/desktop — Evidence Extractor Tests

import { describe, expect, it } from "vitest";
import { EvidenceExtractor } from "../research-evidence.js";

const DOC = [
  "Project X released version 2.0 in March. The release adds local inference support.",
  "Benchmarks show version 2.0 is twice as fast as version 1.9 on consumer GPUs.",
  "The team credits quantization research for the memory reduction.",
].join(" ");

const MULTI_PARAGRAPH = [
  "First paragraph introduces the topic of local inference.",
  "It mentions llama.cpp and Ollama by name.",
  "",
  "Second paragraph covers quantization.",
  "Quantization reduces memory with modest quality loss.",
  "",
  "Third paragraph is unrelated filler about weather patterns.",
].join("\n");

describe("EvidenceExtractor", () => {
  it("extracts verbatim excerpts ranked by query terms", () => {
    const extractor = new EvidenceExtractor({ maxExcerpts: 2 });
    const out = extractor.extract({
      sourceId: "source-1",
      text: DOC,
      queryTerms: ["quantization"],
    });
    expect(out).toHaveLength(2);
    for (const item of out) {
      expect(DOC.includes(item.excerpt.replace(/…$/, "").trimEnd())).toBe(true);
    }
    expect(out.some((e) => e.excerpt.toLowerCase().includes("quantization"))).toBe(true);
  });

  it("takes leading sentences when no query terms are given", () => {
    const extractor = new EvidenceExtractor({ maxExcerpts: 1 });
    const out = extractor.extract({ sourceId: "source-1", text: DOC });
    expect(out).toHaveLength(1);
    expect(out[0]?.excerpt.startsWith("Project X released")).toBe(true);
  });

  it("returns [] for empty or whitespace text", () => {
    const extractor = new EvidenceExtractor();
    expect(extractor.extract({ sourceId: "s", text: "" })).toEqual([]);
    expect(extractor.extract({ sourceId: "s", text: "   \n  " })).toEqual([]);
  });

  it("caps excerpts at maxCharsPerExcerpt with ellipsis", () => {
    const extractor = new EvidenceExtractor({ maxExcerpts: 1, maxCharsPerExcerpt: 30 });
    const out = extractor.extract({ sourceId: "s", text: DOC });
    expect(out[0]?.excerpt.length).toBeLessThanOrEqual(41);
    expect(out[0]?.excerpt.endsWith("…")).toBe(true);
  });

  it("assigns paragraph locators from document structure", () => {
    const extractor = new EvidenceExtractor({ maxExcerpts: 5 });
    const out = extractor.extract({
      sourceId: "s",
      text: MULTI_PARAGRAPH,
      queryTerms: ["quantization"],
    });
    expect(out.length).toBeGreaterThan(0);
    for (const item of out) {
      expect(item.locator?.kind).toBe("paragraph");
      expect(item.locator?.value).toMatch(/^paragraph-\d+$/);
    }
    const quant = out.find((e) => e.excerpt.toLowerCase().includes("quantization"));
    expect(quant?.locator?.value).toBe("paragraph-1");
  });

  it("holds the verbatim invariant on a multi-paragraph doc", () => {
    const extractor = new EvidenceExtractor({ maxExcerpts: 4, maxCharsPerExcerpt: 120 });
    const out = extractor.extract({
      sourceId: "s",
      text: MULTI_PARAGRAPH,
      queryTerms: ["paragraph", "inference", "quantization", "weather"],
    });
    expect(out.length).toBeGreaterThan(1);
    for (const item of out) {
      const probe = item.excerpt.endsWith("…") ? item.excerpt.slice(0, -1).trimEnd() : item.excerpt;
      expect(MULTI_PARAGRAPH.includes(probe)).toBe(true);
    }
  });

  it("defaults retrievedAt and passes requestId through", () => {
    const extractor = new EvidenceExtractor({ maxExcerpts: 1 });
    const out = extractor.extract({ sourceId: "s", text: DOC, requestId: "req-9" });
    expect(out[0]?.requestId).toBe("req-9");
    expect(typeof out[0]?.retrievedAt).toBe("string");
  });

  it("respects maxExcerpts across long documents", () => {
    const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} about agents.`).join(
      " ",
    );
    const extractor = new EvidenceExtractor({ maxExcerpts: 3 });
    const out = extractor.extract({ sourceId: "s", text: long, queryTerms: ["agents"] });
    expect(out).toHaveLength(3);
  });
});
