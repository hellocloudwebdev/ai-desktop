// PR35: apps/desktop — Research Limits & Policy
//
// Centralized bounds for response sizes, document characters, result counts,
// timeouts, redirects, and concurrency. Tests assert against these values
// rather than hard-coded literals scattered through adapters.

import type { ResearchChannel } from "@ai-desktop/ai-core";
import {
  MAX_CONCURRENT_RESEARCH_REQUESTS,
  MAX_DECOMPRESSED_BYTES,
  MAX_REDIRECTS,
  MAX_RESEARCH_CACHE_ENTRIES,
  MAX_RESEARCH_DOCUMENT_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_RSS_ITEMS,
  MAX_SEARCH_RESULTS,
  RESEARCH_CACHE_TTL_MS,
} from "@ai-desktop/ai-core";

export interface ResearchTimeoutPolicy {
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly subprocessTimeoutMs: number;
  readonly browserFallbackTimeoutMs: number;
}

export const DEFAULT_RESEARCH_TIMEOUTS: ResearchTimeoutPolicy = {
  connectTimeoutMs: 8000,
  headersTimeoutMs: 10000,
  bodyTimeoutMs: 25000,
  overallTimeoutMs: 45000,
  subprocessTimeoutMs: 30000,
  browserFallbackTimeoutMs: 60000,
};

export interface ResearchPolicy {
  readonly maxResponseBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxRedirects: number;
  readonly maxDocumentChars: number;
  readonly maxSearchResults: number;
  readonly maxRssItems: number;
  readonly maxConcurrentRequests: number;
  readonly maxCacheEntries: number;
  readonly cacheTtlMs: Record<ResearchChannel, number>;
  readonly timeouts: ResearchTimeoutPolicy;
  /**
   * Host-controlled SSRF bypass entries for trusted test/development
   * origins. Exact lowercase hostnames or literal IPs, empty by default.
   * Never populated from model input.
   */
  readonly allowedHosts?: readonly string[];
}

export const DEFAULT_RESEARCH_POLICY: ResearchPolicy = {
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
  maxRedirects: MAX_REDIRECTS,
  maxDocumentChars: MAX_RESEARCH_DOCUMENT_CHARS,
  maxSearchResults: MAX_SEARCH_RESULTS,
  maxRssItems: MAX_RSS_ITEMS,
  maxConcurrentRequests: MAX_CONCURRENT_RESEARCH_REQUESTS,
  maxCacheEntries: MAX_RESEARCH_CACHE_ENTRIES,
  cacheTtlMs: { ...RESEARCH_CACHE_TTL_MS },
  timeouts: { ...DEFAULT_RESEARCH_TIMEOUTS },
};

export function resolveResearchPolicy(overrides?: Partial<ResearchPolicy>): ResearchPolicy {
  if (!overrides) {
    return DEFAULT_RESEARCH_POLICY;
  }
  return {
    ...DEFAULT_RESEARCH_POLICY,
    ...overrides,
    cacheTtlMs: { ...DEFAULT_RESEARCH_POLICY.cacheTtlMs, ...(overrides.cacheTtlMs ?? {}) },
    timeouts: { ...DEFAULT_RESEARCH_POLICY.timeouts, ...(overrides.timeouts ?? {}) },
  };
}
