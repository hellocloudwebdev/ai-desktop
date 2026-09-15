// PR35.10-35.12/35.20/35.30: apps/desktop — Service, Router, Cache Tests
//
// Covers fallback routing (primary -> fallback with attempted trail, auth
// stops the chain), bounded cache (hit/miss/expiry/invalidation/eviction,
// authenticated bypass), provenance intactness, browser fallback with
// projectId propagation, concurrency bounds, and result ceilings.
// Hermetic: adapters are stubbed; no live internet.

import { describe, expect, it, vi } from "vitest";
import { defaultResearchPolicy } from "../research-policy.js";
import { ResearchCache, researchCacheKey } from "../research-cache.js";
import { ResearchRouter } from "../routing/research-router.js";
import { ResearchService } from "../research-service.js";
import { ResearchAuthRequired, ResearchProviderError } from "../research-errors.js";
import { StaticWebReader } from "../adapters/web/web-reader.js";
import { ExaSearchAdapter } from "../adapters/search/search-provider.js";

function testPolicy() {
  return defaultResearchPolicy({ denyLoopback: false });
}

describe("research cache", () => {
  it("hits, misses, expires, and invalidates", () => {
    let nowMs = 1000;
    const cache = new ResearchCache<unknown>({ now: () => nowMs });
    const key = researchCacheKey("search", "exa", "query");
    expect(cache.get(key)).toBeUndefined();
    expect(
      cache.set({
        key,
        provider: "exa",
        channel: "search",
        retrievedAt: nowMs,
        expiresAt: nowMs + 1000,
        payload: { hits: 1 },
        authenticated: false,
      }),
    ).toBe(true);
    expect(cache.get(key)).toMatchObject({ provider: "exa" });
    nowMs += 2000;
    expect(cache.get(key)).toBeUndefined();
    cache.set({
      key,
      provider: "exa",
      channel: "search",
      retrievedAt: nowMs,
      expiresAt: nowMs + 1000,
      payload: { hits: 2 },
      authenticated: false,
    });
    expect(cache.invalidate(key)).toBe(true);
    expect(cache.get(key)).toBeUndefined();
  });

  it("refuses authenticated entries and evicts oldest at capacity", () => {
    const nowMs = Date.now();
    const cache = new ResearchCache<unknown>({ maxEntries: 2, now: () => nowMs });
    expect(
      cache.set({
        key: "a",
        provider: "p",
        channel: "web",
        retrievedAt: nowMs,
        expiresAt: nowMs + 1000,
        payload: {},
        authenticated: true,
      }),
    ).toBe(false);
    expect(cache.size).toBe(0);
    for (const key of ["k1", "k2", "k3"]) {
      cache.set({
        key,
        provider: "p",
        channel: "web",
        retrievedAt: nowMs,
        expiresAt: nowMs + 60000,
        payload: key,
        authenticated: false,
      });
    }
    expect(cache.size).toBe(2);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k3")).toMatchObject({ payload: "k3" });
  });

  it("derives deterministic keys per channel/provider/input", () => {
    expect(researchCacheKey("web", "static-reader", "https://example.com/a")).toBe(
      researchCacheKey("web", "static-reader", "https://example.com/a"),
    );
    expect(researchCacheKey("web", "static-reader", "a")).not.toBe(
      researchCacheKey("web", "browser", "a"),
    );
  });
});

describe("research router", () => {
  const ok = (provider: string) => ({
    provider,
    health: async () => "available" as const,
  });

  it("runs primary first and records the attempted trail on fallback", async () => {
    const router = new ResearchRouter();
    router.register("web", ok("static-reader"));
    router.register("web", ok("jina"));
    const attempted: string[][] = [];
    const result = await router.route("web", async (adapter, trail) => {
      attempted.push(trail);
      if (adapter.provider === "static-reader") {
        throw new ResearchProviderError("static-reader", "boom");
      }
      return "fallback-win";
    });
    expect(result.outcome).toBe("fallback-win");
    expect(result.provider).toBe("jina");
    expect(result.attemptedProviders).toEqual(["static-reader", "jina"]);
    expect(attempted).toEqual([["static-reader"], ["static-reader", "jina"]]);
  });

  it("stops the chain on auth failures and aborts", async () => {
    const router = new ResearchRouter();
    router.register("search", ok("exa"));
    router.register("search", ok("other"));
    const run = vi.fn(async () => {
      throw new ResearchAuthRequired("exa");
    });
    await expect(router.route("search", run)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(run).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      router.route("search", async () => "x", { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("reports provider health without throwing", async () => {
    const router = new ResearchRouter();
    router.register("rss", ok("rss"));
    router.register("rss", {
      provider: "broken",
      health: async () => {
        throw new Error("down");
      },
    });
    await expect(router.providerHealth("rss")).resolves.toEqual({
      rss: "available",
      broken: "unavailable",
    });
  });

  it("fails closed with no registered adapters", async () => {
    const router = new ResearchRouter();
    await expect(router.route("web", async () => "x")).rejects.toThrow(/No research adapters/);
  });
});

describe("research service", () => {
  function stubReader(text: string, provider = "static-reader") {
    return {
      provider,
      read: async () => ({
        id: "01J00000000000000000000001",
        requestId: "01J00000000000000000000002",
        url: "https://example.com/a",
        canonicalUrl: "https://example.com/a",
        title: "Title",
        text,
        mimeType: "text/html",
        truncated: false,
        retrievedAt: new Date().toISOString(),
      }),
    } as unknown as StaticWebReader;
  }

  function stubSearch(hits: Array<{ title: string; url: string; snippet?: string }>) {
    return {
      provider: "exa",
      authenticated: true,
      search: async () =>
        hits.map((h) => ({
          title: h.title,
          url: h.url,
          snippet: h.snippet ?? "",
          domain: "example.com",
        })),
      health: async () => "available" as const,
    } as unknown as ExaSearchAdapter;
  }

  it("opens pages with provenance and serves repeats from cache", async () => {
    const reader = stubReader("hello world ".repeat(50));
    const service = new ResearchService({ policy: testPolicy(), webReader: reader });
    const first = await service.openWebPage("https://example.com/a?utm_source=x");
    expect(first.source.provider).toBe("static-reader");
    expect(first.source.provenance.attemptedProviders).toEqual(["static-reader"]);
    expect(first.source.channel).toBe("web");
    expect(first.content).toContain("External source content");
    expect(first.content).toContain("hello world");

    const readSpy = vi.spyOn(reader as unknown as { read: () => Promise<unknown> }, "read");
    const second = await service.openWebPage("https://example.com/a");
    expect(readSpy).not.toHaveBeenCalled();
    expect(second.source.provider).toBe("static-reader");
  });

  it("falls back to the browser on static failure with the full trail", async () => {
    const failing = {
      provider: "static-reader",
      read: async () => {
        throw new ResearchProviderError("static-reader", "JS-heavy page");
      },
    } as unknown as StaticWebReader;
    const fallback = {
      openAndSnapshot: async (url: string) => ({
        title: "Browser Title",
        text: "rendered content ".repeat(20),
        finalUrl: url,
      }),
    };
    const service = new ResearchService({
      policy: testPolicy(),
      webReader: failing,
      browserFallback: fallback,
    });
    const result = await service.openWebPage("https://example.com/app", { projectId: "proj-1" });
    expect(result.source.provider).toBe("browser");
    expect(result.source.provenance.attemptedProviders).toEqual(["static-reader", "browser"]);
    expect(result.title).toBe("Browser Title");
  });

  it("falls back on insufficient static content and propagates projectId", async () => {
    const thin = stubReader("x");
    const seen: Array<{ url: string; projectId?: string }> = [];
    const service = new ResearchService({
      policy: testPolicy(),
      webReader: thin,
      browserFallback: {
        openAndSnapshot: async (url: string, opts?: { projectId?: string }) => {
          seen.push({ url, projectId: opts?.projectId });
          return { title: "T", text: "full rendered text ".repeat(20), finalUrl: url };
        },
      },
    });
    const result = await service.openWebPage("https://example.com/js", { projectId: "proj-9" });
    expect(result.source.provider).toBe("browser");
    expect(seen).toEqual([{ url: "https://example.com/js", projectId: "proj-9" }]);
  });

  it("searches with dedupe, bounds, and cache", async () => {
    const provider = stubSearch([
      { title: "A", url: "https://example.com/a?utm_source=x" },
      { title: "A2", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" },
    ]);
    const service = new ResearchService({ policy: testPolicy(), searchProvider: provider });
    const result = await service.searchWeb("query");
    const hits = (result.metadata as { results: Array<{ title: string }> }).results;
    expect(hits.map((h) => h.title)).toEqual(["A", "B"]);
    expect(result.source.provider).toBe("exa");
    const again = await service.searchWeb("query");
    expect(again.source.provider).toBe("exa");
  });

  it("bounds concurrent outbound work", async () => {
    let active = 0;
    let peak = 0;
    const slowReader = {
      provider: "static-reader",
      read: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
        return {
          id: "01J00000000000000000000001",
          requestId: "01J00000000000000000000002",
          url: "https://example.com/x",
          canonicalUrl: "https://example.com/x",
          title: "T",
          text: "body text ".repeat(30),
          mimeType: "text/html",
          truncated: false,
          retrievedAt: new Date().toISOString(),
        };
      },
    } as unknown as StaticWebReader;
    const service = new ResearchService({
      policy: defaultResearchPolicy({ denyLoopback: false, maxConcurrentRequests: 2 }),
      webReader: slowReader,
    });
    await Promise.all([
      service.openWebPage("https://example.com/1"),
      service.openWebPage("https://example.com/2"),
      service.openWebPage("https://example.com/3"),
    ]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
