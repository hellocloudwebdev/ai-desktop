// PR35: apps/desktop — Search Provider Adapters
//
// SearchProvider boundary: provider SDK/API types stay inside the adapter.
// Ships with two host-safe providers:
//   1. ConfiguredSearchAdapter — delegates to a host-configured HTTP search
//      endpoint (response normalized; never executes model-provided URLs).
//   2. NullSearchAdapter — explicit "no provider configured" placeholder that
//      fails with a clear, model-safe error so search degrades loudly.

import type { ResearchChannel, ResearchSearchResult } from "@ai-desktop/ai-core";
import { MAX_SEARCH_RESULTS } from "@ai-desktop/ai-core";
import { ResearchCancelled, ResearchProviderUnavailable } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "../../research-policy.js";
import { secureFetch } from "../../security/secure-fetch.js";
import type { DnsResolver } from "../../security/ssrf-guard.js";
import type { AdapterContext, ResearchAdapter, SearchOutput } from "../adapter.js";

export interface SearchProvider {
  readonly provider: string;
  search(query: string, limit: number, ctx: AdapterContext): Promise<ResearchSearchResult[]>;
}

export interface ConfiguredSearchEndpoint {
  readonly provider: string;
  readonly endpoint: string;
  /** Header names only — values resolve host-side (SecretRef), never from the model. */
  readonly apiKeySecretRef?: string;
  readonly resolveApiKey?: () => Promise<string | null>;
}

export interface SearchAdapterDeps {
  readonly provider?: SearchProvider;
  readonly policy?: ResearchPolicy;
  readonly resolver?: DnsResolver;
}

function boundLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    return 10;
  }
  return Math.min(Math.floor(limit), MAX_SEARCH_RESULTS);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function dedupeSearchResults(results: ResearchSearchResult[]): ResearchSearchResult[] {
  const seen = new Set<string>();
  const out: ResearchSearchResult[] = [];
  for (const item of results) {
    const key = item.url.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

export class NullSearchProvider implements SearchProvider {
  readonly provider = "none";

  async search(): Promise<ResearchSearchResult[]> {
    throw new ResearchProviderUnavailable(
      "none",
      "No search provider is configured. Configure a host search backend to enable research.search.",
    );
  }
}

/**
 * Host-configured generic HTTP search backend. The endpoint must return
 * `{ results: [{ title, url, snippet?, publishedAt?, score? }] }`.
 * Auth material resolves host-side; the model supplies only query + limit.
 */
export class ConfiguredSearchProvider implements SearchProvider {
  readonly provider: string;
  private readonly _endpoint: string;
  private readonly _policy: ResearchPolicy;
  private readonly _resolver?: DnsResolver;
  private readonly _resolveApiKey?: () => Promise<string | null>;

  constructor(
    endpoint: ConfiguredSearchEndpoint,
    deps: { policy?: ResearchPolicy; resolver?: DnsResolver } = {},
  ) {
    this.provider = endpoint.provider;
    this._endpoint = endpoint.endpoint;
    this._policy = deps.policy ?? DEFAULT_RESEARCH_POLICY;
    this._resolver = deps.resolver;
    this._resolveApiKey = endpoint.resolveApiKey;
  }

  async search(query: string, limit: number, ctx: AdapterContext): Promise<ResearchSearchResult[]> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const url = new URL(this._endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(boundLimit(limit)));
    const headers: Record<string, string> = {};
    if (this._resolveApiKey) {
      const key = await this._resolveApiKey();
      // The key value never enters provenance, logs, or results.
      if (key) {
        headers["authorization"] = `Bearer ${key}`;
      }
    }
    const fetched = await secureFetch(url.toString(), {
      policy: this._policy,
      ...(this._resolver ? { resolver: this._resolver } : {}),
      ...(this._policy.allowedHosts
        ? { allowlist: { allowedHosts: this._policy.allowedHosts } }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.body.toString("utf-8"));
    } catch {
      return [];
    }
    const raw =
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { results?: unknown }).results)
        ? ((parsed as { results: unknown[] }).results ?? [])
        : [];
    const results: ResearchSearchResult[] = [];
    for (const item of raw.slice(0, boundLimit(limit))) {
      if (item === null || typeof item !== "object") {
        continue;
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry["title"] !== "string" || typeof entry["url"] !== "string") {
        continue;
      }
      results.push({
        title: entry["title"].slice(0, 300),
        url: entry["url"].slice(0, 2048),
        snippet: typeof entry["snippet"] === "string" ? entry["snippet"].slice(0, 1000) : "",
        domain: domainOf(entry["url"]),
        ...(typeof entry["publishedAt"] === "string" ? { publishedAt: entry["publishedAt"] } : {}),
        ...(typeof entry["score"] === "number" && Number.isFinite(entry["score"])
          ? { score: entry["score"] }
          : {}),
      });
    }
    return dedupeSearchResults(results);
  }
}

export class SearchAdapter implements ResearchAdapter {
  readonly provider: string;
  readonly channel: ResearchChannel = "search";
  private readonly _backend: SearchProvider;

  constructor(deps: SearchAdapterDeps = {}) {
    this._backend = deps.provider ?? new NullSearchProvider();
    this.provider = this._backend.provider;
  }

  async search(query: string, limit: number, ctx: AdapterContext): Promise<SearchOutput> {
    const results = await this._backend.search(query, boundLimit(limit), ctx);
    return { results: dedupeSearchResults(results).slice(0, MAX_SEARCH_RESULTS) };
  }
}
