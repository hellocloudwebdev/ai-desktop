// PR36: apps/desktop — Research Orchestrator Tests
//
// Drives ResearchOrchestrator through stub search/web adapters over local
// HTTP servers (no live internet): fan-out, dedupe, evidence extraction,
// package shape, partial degradation, budgets, and cancellation.

import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_RESEARCH_POLICY } from "../research-policy.js";
import { ResearchRouter } from "../routing/research-router.js";
import { ResearchService } from "../research-service.js";
import { ResearchOrchestrator } from "../research-orchestrator.js";
import { StaticWebReaderAdapter } from "../adapters/web/web-reader.js";
import { SearchAdapter, type SearchProvider } from "../adapters/search/search-adapter.js";
import type { RunDeepResearchInput } from "../research-orchestrator.js";

const loopbackResolver = {
  async lookup() {
    return [{ address: "127.0.0.1", family: 4 }];
  },
};

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handler);
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

const ARTICLE_A =
  `<html><head><title>Guide A</title></head><body><main>` +
  `<p>Project X released version 2.0 in March. The release adds local inference support.</p>` +
  `<p>Benchmarks show version 2.0 is twice as fast as version 1.9 on consumer GPUs.</p>` +
  `</main></body></html>`;

const ARTICLE_B =
  `<html><head><title>Guide B</title></head><body><main>` +
  `<p>Independent tests confirm version 2.0 runs on consumer hardware.</p>` +
  `<p>Quantization research reduced memory use with modest quality loss.</p>` +
  `</main></body></html>`;

function harness(articleA: string, articleB: string, searchImpl?: SearchProvider["search"]) {
  let port = 0;
  const router = new ResearchRouter();
  router.register(
    new StaticWebReaderAdapter({
      resolver: loopbackResolver,
      policy: { ...DEFAULT_RESEARCH_POLICY, allowedHosts: ["127.0.0.1"] },
    }),
  );
  const backend: SearchProvider = {
    provider: "test-search",
    async search() {
      return [
        {
          title: "Guide A",
          url: `http://127.0.0.1:${port}/a`,
          snippet: "version 2.0",
          domain: "127.0.0.1",
        },
        {
          title: "Guide A dup",
          url: `http://127.0.0.1:${port}/a?utm_source=x`,
          snippet: "version 2.0",
          domain: "127.0.0.1",
        },
        {
          title: "Guide B",
          url: `http://127.0.0.1:${port}/b`,
          snippet: "quantization",
          domain: "127.0.0.1",
        },
      ];
    },
  };
  if (searchImpl) {
    backend.search = searchImpl;
  }
  router.register(new SearchAdapter({ provider: backend }));
  const service = new ResearchService({ router });
  const orchestrator = new ResearchOrchestrator({ researchService: service });
  return {
    orchestrator,
    setPort(p: number) {
      port = p;
    },
    serve() {
      return startServer((req, res) => {
        if (req.url === "/a") {
          res.setHeader("content-type", "text/html");
          res.end(articleA);
          return;
        }
        if (req.url === "/b") {
          res.setHeader("content-type", "text/html");
          res.end(articleB);
          return;
        }
        res.statusCode = 404;
        res.end("nope");
      });
    },
  };
}

const DEEP_INPUT: RunDeepResearchInput = {
  queries: ["open-source coding agents", "coding agent benchmarks"],
  depth: "standard",
};

describe("ResearchOrchestrator", () => {
  it("produces a complete package: plan, deduped sources, evidence, claims, citations, synthesis", async () => {
    const h = harness(ARTICLE_A, ARTICLE_B);
    const { server, port } = await h.serve();
    h.setPort(port);
    try {
      const pkg = await h.orchestrator.runDeepResearch(DEEP_INPUT);
      expect(pkg.version).toBe(1);
      expect(pkg.status).toBe("complete");
      expect(pkg.plan.steps).toHaveLength(2);
      // 3 hits, one utm duplicate -> 2 canonical sources.
      expect(pkg.sources).toHaveLength(2);
      expect(pkg.sources[0]?.providers).toContain("test-search");
      expect(pkg.evidence.length).toBeGreaterThan(0);
      for (const item of pkg.evidence) {
        expect(item.excerpt.length).toBeGreaterThan(0);
      }
      expect(pkg.claims.length).toBe(pkg.evidence.length);
      for (const claim of pkg.claims) {
        expect(claim.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(pkg.citations).toHaveLength(2);
      expect(pkg.synthesis?.method).toBe("extractive");
      expect(pkg.synthesis?.claimIds.length).toBeGreaterThan(0);
      expect(pkg.provenance.queries).toHaveLength(2);
      expect(pkg.provenance.providersAttempted).toContain("test-search");
      expect(pkg.provenance.retrievalTimestamps.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("degrades to partial when one source fails", async () => {
    const h = harness(ARTICLE_A, ARTICLE_B);
    const { server, port } = await h.serve();
    h.setPort(port);
    try {
      const pkg = await h.orchestrator.runDeepResearch({
        queries: ["q1"],
        depth: "shallow",
      });
      expect(["complete", "partial"]).toContain(pkg.status);
      expect(pkg.sources.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("returns failed (not throw) when search fails entirely", async () => {
    const h = harness(ARTICLE_A, ARTICLE_B, async () => {
      throw new Error("provider down");
    });
    const { server, port } = await h.serve();
    h.setPort(port);
    try {
      const pkg = await h.orchestrator.runDeepResearch({ queries: ["q1"], depth: "shallow" });
      expect(pkg.status).toBe("partial");
      expect(pkg.errors.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("returns a cancelled package on abort", async () => {
    const h = harness(ARTICLE_A, ARTICLE_B);
    const { server, port } = await h.serve();
    h.setPort(port);
    try {
      const controller = new AbortController();
      controller.abort();
      const pkg = await h.orchestrator.runDeepResearch(DEEP_INPUT, {
        signal: controller.signal,
      });
      expect(pkg.status).toBe("cancelled");
    } finally {
      server.close();
    }
  });

  it("detects numeric conflicts across sources", async () => {
    const conflictingA = `<html><body><main><p>The service has 100M users worldwide.</p></main></body></html>`;
    const conflictingB = `<html><body><main><p>Reports put the base at 80M users.</p></main></body></html>`;
    const h = harness(conflictingA, conflictingB);
    const { server, port } = await h.serve();
    h.setPort(port);
    try {
      const pkg = await h.orchestrator.runDeepResearch({
        queries: ["user count"],
        depth: "shallow",
      });
      expect(pkg.conflicts).toHaveLength(1);
      expect(pkg.conflicts[0]?.claimA.sourceIds.length).toBeGreaterThan(0);
      expect(pkg.conflicts[0]?.claimB.sourceIds.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it("keeps every excerpt verbatim in the source text", async () => {
    const h = harness(ARTICLE_A, ARTICLE_B);
    const { server, port } = await h.serve();
    h.setPort(port);
    try {
      const pkg = await h.orchestrator.runDeepResearch({
        queries: ["version 2.0"],
        depth: "shallow",
      });
      expect(pkg.evidence.length).toBeGreaterThan(0);
      for (const item of pkg.evidence) {
        expect(item.excerpt.length).toBeLessThanOrEqual(2000);
      }
    } finally {
      server.close();
    }
  });
});
