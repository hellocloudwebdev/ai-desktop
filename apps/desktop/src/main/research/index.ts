// PR35: apps/desktop — Research Barrel
//
// Public boundary for the research subsystem: service, executor, cache,
// router, provenance, policy, errors, and adapters. The PR34 browser
// boundary (BrowserService) is consumed structurally, never re-exported.

export * from "./research-errors.js";
export * from "./research-policy.js";
export * from "./research-cache.js";
export * from "./research-provenance.js";
export * from "./research-service.js";
export * from "./research-tool-executor.js";
export * from "./routing/research-router.js";
export * from "./security/url-policy.js";
export * from "./security/ssrf-guard.js";
export * from "./security/redirect-policy.js";
export * from "./security/response-policy.js";
export * from "./adapters/web/web-reader.js";
export * from "./adapters/search/search-provider.js";
export * from "./adapters/github/github-research.js";
export * from "./adapters/youtube/youtube-research.js";
export * from "./adapters/rss/rss-research.js";
