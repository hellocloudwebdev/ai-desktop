// PR35.6/35.9: apps/desktop — Research Policy (centralized limits & config)
//
// Invariants:
//   1. Every timeout, byte ceiling, count ceiling, and TTL derives from the
//      ai-core centralized constants. No provider-specific infinite
//      requests, no hardcoded magic numbers in adapters.
//   2. Tests construct the default policy and may override individual fields;
//      production always starts from defaultResearchPolicy().

import {
  MAX_CONCURRENT_RESEARCH_REQUESTS,
  MAX_DECOMPRESSED_BYTES,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_RESEARCH_CACHE_ENTRIES,
  MAX_RESEARCH_CONTENT_CHARS,
  MAX_RESEARCH_DOCUMENT_CHARS,
  MAX_RSS_ITEMS,
  MAX_SEARCH_RESULTS,
  RESEARCH_CACHE_TTL_MS,
  RESEARCH_TIMEOUTS_MS,
  type ResearchChannel,
} from "@ai-desktop/ai-core";

export interface ResearchPolicy {
  readonly maxSearchResults: number;
  readonly maxRssItems: number;
  readonly maxContentChars: number;
  readonly maxDocumentChars: number;
  readonly maxResponseBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxRedirects: number;
  readonly maxConcurrentRequests: number;
  readonly maxCacheEntries: number;
  readonly cacheTtlMs: Record<ResearchChannel, number>;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly browserFallbackTimeoutMs: number;
  /** When false (tests), loopback destinations are permitted. Production: true. */
  readonly denyLoopback: boolean;
  /** Optional extra host allowlist. Undefined = no allowlist restriction. */
  readonly allowedHosts?: readonly string[];
}

export function defaultResearchPolicy(overrides?: Partial<ResearchPolicy>): ResearchPolicy {
  return {
    maxSearchResults: MAX_SEARCH_RESULTS,
    maxRssItems: MAX_RSS_ITEMS,
    maxContentChars: MAX_RESEARCH_CONTENT_CHARS,
    maxDocumentChars: MAX_RESEARCH_DOCUMENT_CHARS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
    maxRedirects: MAX_REDIRECTS,
    maxConcurrentRequests: MAX_CONCURRENT_RESEARCH_REQUESTS,
    maxCacheEntries: MAX_RESEARCH_CACHE_ENTRIES,
    cacheTtlMs: { ...RESEARCH_CACHE_TTL_MS },
    connectTimeoutMs: RESEARCH_TIMEOUTS_MS.connect,
    requestTimeoutMs: RESEARCH_TIMEOUTS_MS.request,
    bodyTimeoutMs: RESEARCH_TIMEOUTS_MS.body,
    overallTimeoutMs: RESEARCH_TIMEOUTS_MS.overall,
    browserFallbackTimeoutMs: RESEARCH_TIMEOUTS_MS.browserFallback,
    denyLoopback: true,
    ...overrides,
  };
}

/** Races a promise against AbortSignal + wall-clock timeout (idempotent). */
export function withResearchTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onTimeout?: () => void,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      Object.assign(new Error("Research operation cancelled"), { name: "AbortError" }),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Timeout hooks must never mask the timeout itself.
      }
      const err = new Error(`Research operation timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        const err = new Error("Research operation cancelled");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  };
  return Promise.race([work.finally(cleanup), timeout.finally(cleanup)]);
}

/**
 * Creates an AbortController linked to an optional parent signal. The child
 * aborts when the parent aborts (or immediately if already aborted).
 * Adapters pass the child signal to fetch so timeouts/cancellation
 * actually stop the underlying HTTP request (no orphaned network work).
 */
export function createLinkedAbortController(parent?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!parent) return controller;
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/** Rejects immediately when already aborted; otherwise returns undefined. */
export function throwIfResearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error("Research operation cancelled"), { name: "AbortError" });
  }
}
