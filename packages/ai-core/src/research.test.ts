// PR35: packages/ai-core — Canonical research contract tests

import { describe, expect, it } from "vitest";
import { createTimestamp } from "@ai-desktop/shared";
import {
  ALLOWED_RESEARCH_MIME_TYPES,
  RESEARCH_CACHE_TTL_MS,
  RESEARCH_TOOL_IDS,
  ResearchDocumentSchema,
  ResearchOpenInputSchema,
  ResearchProvenanceSchema,
  ResearchResultSchema,
  ResearchRssInputSchema,
  ResearchSearchInputSchema,
  ResearchSearchResultSchema,
  ResearchSourceSchema,
  buildAllResearchToolDefinitions,
  buildResearchToolDefinition,
  canonicalizeResearchUrl,
  frameUntrustedContent,
  isResearchChannel,
  isResearchToolId,
  isSafeResearchUrl,
  isSupportedResearchMimeType,
  researchRiskFor,
  researchToolDescription,
} from "./research.js";
import {
  createResearchDocumentId,
  createResearchRequestId,
  createResearchResultId,
  createResearchSourceId,
  parseResearchDocumentId,
  parseResearchRequestId,
  parseResearchResultId,
  parseResearchSourceId,
} from "./identifiers.js";

function provenance(overrides: Record<string, unknown> = {}) {
  return {
    provider: "web-reader",
    channel: "web",
    retrievedAt: createTimestamp(),
    attemptedProviders: ["web-reader"],
    successfulProvider: "web-reader",
    ...overrides,
  };
}

describe("research: channels and tool ids", () => {
  it("accepts the closed channel vocabulary", () => {
    expect(isResearchChannel("web")).toBe(true);
    expect(isResearchChannel("search")).toBe(true);
    expect(isResearchChannel("github")).toBe(true);
    expect(isResearchChannel("youtube")).toBe(true);
    expect(isResearchChannel("rss")).toBe(true);
    expect(isResearchChannel("generic")).toBe(false);
    expect(isResearchChannel("")).toBe(false);
  });

  it("defines exactly five canonical tool ids", () => {
    expect(RESEARCH_TOOL_IDS).toEqual([
      "builtin:research.search",
      "builtin:research.open",
      "builtin:research.github",
      "builtin:research.youtube",
      "builtin:research.rss",
    ]);
    for (const id of RESEARCH_TOOL_IDS) {
      expect(isResearchToolId(id)).toBe(true);
      expect(researchToolDescription(id).length).toBeGreaterThan(0);
    }
    expect(isResearchToolId("builtin:browser.open")).toBe(false);
  });

  it("builds tool definitions with builtin source and in_process runtime", () => {
    const defs = buildAllResearchToolDefinitions();
    expect(defs).toHaveLength(5);
    for (const def of defs) {
      expect(def.source).toBe("builtin");
      expect(def.runtime).toBe("in_process");
      expect(def.requiredPermissions).toEqual(["research"]);
    }
    expect(buildResearchToolDefinition("builtin:research.search").name).toBe(
      "builtin:research.search",
    );
  });
});

describe("research: identifiers", () => {
  it("creates branded ULID identifiers", () => {
    expect(createResearchRequestId().length).toBe(26);
    expect(createResearchSourceId().length).toBe(26);
    expect(createResearchResultId().length).toBe(26);
    expect(createResearchDocumentId().length).toBe(26);
  });

  it("parses and rejects identifiers", () => {
    const raw = createResearchRequestId();
    expect(parseResearchRequestId(raw)).toBe(raw);
    expect(parseResearchSourceId(createResearchSourceId())).toBeDefined();
    expect(parseResearchResultId(createResearchResultId())).toBeDefined();
    expect(parseResearchDocumentId(createResearchDocumentId())).toBeDefined();
    expect(() => parseResearchRequestId("bad-id")).toThrow(TypeError);
    expect(() => parseResearchResultId("bad-id")).toThrow(TypeError);
  });
});

describe("research: provenance and source schemas", () => {
  it("requires provider, channel, timestamps, and fallback ledger", () => {
    const parsed = ResearchProvenanceSchema.parse(provenance());
    expect(parsed.provider).toBe("web-reader");
    expect(parsed.successfulProvider).toBe("web-reader");
    expect(parsed.attemptedProviders).toEqual(["web-reader"]);
  });

  it("rejects empty provider names", () => {
    expect(() => ResearchProvenanceSchema.parse(provenance({ provider: "" }))).toThrow();
  });

  it("parses a full research source", () => {
    const source = ResearchSourceSchema.parse({
      id: createResearchSourceId(),
      channel: "github",
      provider: "github-api",
      url: "https://github.com/example/repo",
      title: "example/repo",
      retrievedAt: createTimestamp(),
      provenance: provenance({
        channel: "github",
        provider: "github-api",
        attemptedProviders: ["github-api"],
        successfulProvider: "github-api",
      }),
    });
    expect(source.channel).toBe("github");
    expect(source.provenance.successfulProvider).toBe("github-api");
  });
});

describe("research: result and document schemas with bounds", () => {
  function baseResult(overrides: Record<string, unknown> = {}) {
    return {
      id: createResearchResultId(),
      requestId: createResearchRequestId(),
      source: {
        id: createResearchSourceId(),
        channel: "web",
        provider: "web-reader",
        url: "https://example.com/article",
        retrievedAt: createTimestamp(),
        provenance: provenance({ sourceUrl: "https://example.com/article" }),
      },
      title: "Example",
      url: "https://example.com/article",
      excerpt: "hello",
      content: "hello world",
      retrievedAt: createTimestamp(),
      truncated: false,
      ...overrides,
    };
  }

  it("parses a bounded result", () => {
    const result = ResearchResultSchema.parse(baseResult());
    expect(result.truncated).toBe(false);
    expect(result.source.channel).toBe("web");
  });

  it("rejects oversized content and excerpts", () => {
    expect(() => ResearchResultSchema.parse(baseResult({ content: "x".repeat(50001) }))).toThrow();
    expect(() => ResearchResultSchema.parse(baseResult({ excerpt: "x".repeat(2001) }))).toThrow();
  });

  it("parses a bounded research document", () => {
    const doc = ResearchDocumentSchema.parse({
      id: createResearchDocumentId(),
      requestId: createResearchRequestId(),
      url: "https://example.com/article",
      title: "Example",
      text: "hello world",
      retrievedAt: createTimestamp(),
      provider: "web-reader",
    });
    expect(doc.title).toBe("Example");
    expect(doc.truncated).toBe(false);
  });

  it("parses a normalized search result", () => {
    const item = ResearchSearchResultSchema.parse({
      title: "Example",
      url: "https://example.com",
      snippet: "snippet",
      domain: "example.com",
    });
    expect(item.domain).toBe("example.com");
  });

  it("validates search/open/rss input bounds", () => {
    expect(ResearchSearchInputSchema.parse({ query: "local llm" }).limit).toBe(10);
    expect(() => ResearchSearchInputSchema.parse({ query: "" })).toThrow();
    expect(() => ResearchSearchInputSchema.parse({ query: "x".repeat(501) })).toThrow();
    expect(() => ResearchOpenInputSchema.parse({ url: "javascript:alert(1)" })).toThrow();
    expect(ResearchRssInputSchema.parse({ feedUrl: "https://example.com/feed" }).limit).toBe(20);
  });

  it("serializes results to JSON without secrets", () => {
    const result = ResearchResultSchema.parse(baseResult());
    const json = JSON.stringify(result);
    expect(json).not.toContain("api-key");
    expect(JSON.parse(json).id).toBe(result.id);
  });
});

describe("research: URL policy", () => {
  it("accepts http/https and rejects dangerous schemes", () => {
    expect(isSafeResearchUrl("https://example.com/article")).toBe(true);
    expect(isSafeResearchUrl("http://example.com")).toBe(true);
    expect(isSafeResearchUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeResearchUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeResearchUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeResearchUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeResearchUrl("blob:https://example.com/x")).toBe(false);
    expect(isSafeResearchUrl("ftp://example.com/x")).toBe(false);
    expect(isSafeResearchUrl("gopher://example.com")).toBe(false);
    expect(isSafeResearchUrl("")).toBe(false);
    expect(isSafeResearchUrl("not-a-url")).toBe(false);
  });

  it("canonicalizes URLs by stripping fragments and tracking params", () => {
    expect(canonicalizeResearchUrl("https://example.com/a?utm_source=x&b=1#frag")).toBe(
      "https://example.com/a?b=1",
    );
    expect(canonicalizeResearchUrl("https://example.com:443/")).toBe("https://example.com");
    expect(canonicalizeResearchUrl("https://EXAMPLE.com/a")).toBe("https://example.com/a");
    expect(canonicalizeResearchUrl("https://example.com/a?x=1&x=2")).toBe(
      "https://example.com/a?x=1&x=2",
    );
  });
});

describe("research: MIME policy, TTLs, risk, framing", () => {
  it("supports the documented MIME vocabulary", () => {
    expect(ALLOWED_RESEARCH_MIME_TYPES).toContain("text/html");
    expect(ALLOWED_RESEARCH_MIME_TYPES).toContain("application/rss+xml");
    expect(isSupportedResearchMimeType("text/html; charset=utf-8")).toBe(true);
    expect(isSupportedResearchMimeType("application/pdf")).toBe(false);
    expect(isSupportedResearchMimeType("application/octet-stream")).toBe(false);
  });

  it("centralizes cache TTLs per channel", () => {
    expect(RESEARCH_CACHE_TTL_MS.web).toBe(15 * 60 * 1000);
    expect(RESEARCH_CACHE_TTL_MS.search).toBe(5 * 60 * 1000);
    expect(RESEARCH_CACHE_TTL_MS.youtube).toBe(60 * 60 * 1000);
    expect(RESEARCH_CACHE_TTL_MS.rss).toBe(30 * 60 * 1000);
  });

  it("classifies public reads as low risk and authenticated reads as medium", () => {
    expect(researchRiskFor("search")).toBe("low");
    expect(researchRiskFor("open")).toBe("low");
    expect(researchRiskFor("github")).toBe("low");
    expect(researchRiskFor("search", true)).toBe("medium");
    expect(researchRiskFor("unknown-action")).toBe("medium");
  });

  it("frames untrusted content with the canonical header", () => {
    const framed = frameUntrustedContent("hello");
    expect(framed).toContain("untrusted");
    expect(framed).toContain("hello");
  });
});
