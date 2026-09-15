// PR35.15-35.16: apps/desktop — Search Provider + Exa Adapter
//
// Invariants:
//   1. SearchProvider is the interface (query -> normalized SearchResults).
//      The Exa adapter keeps SDK/API types inside this file; ai-core sees
//      only normalized results.
//   2. No LLM reranker: provider ordering is preserved; dedupe by canonical
//      URL is the only reordering. Bounds derive from the research policy.
//   3. API keys resolve only via the injected SecretRef resolver — never env
//      passthrough, never raw keys in inputs/outputs/errors. Without a key
//      the adapter reports authRequired instead of failing obscurely.

import {
  canonicalizeResearchUrl,
  dedupeSearchResults,
  type SearchResult,
} from "@ai-desktop/ai-core";
import { ResearchAuthRequired, toCanonicalResearchError } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import {
  createLinkedAbortController,
  defaultResearchPolicy,
  throwIfResearchAborted,
  withResearchTimeout,
} from "../../research-policy.js";

export interface SearchOptions {
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
}

export interface SearchProvider {
  readonly provider: string;
  readonly authenticated: boolean;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  health(): Promise<"available" | "authRequired" | "unavailable">;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export interface ExaSearchDeps {
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveSecret?: (ref: string) => Promise<string | null>;
  readonly apiKeyRef?: string;
  readonly endpoint?: string;
}

/** Exa /search adapter: normalized, bounded, provider-ordered results. */
export class ExaSearchAdapter implements SearchProvider {
  readonly provider = "exa";
  private readonly _policy: ResearchPolicy;
  private readonly _fetchFn: typeof fetch;
  private readonly _resolveSecret?: (ref: string) => Promise<string | null>;
  private readonly _apiKeyRef?: string;
  private readonly _endpoint: string;

  constructor(deps?: ExaSearchDeps) {
    this._policy = deps?.policy ?? defaultResearchPolicy();
    this._fetchFn = deps?.fetchFn ?? fetch;
    this._resolveSecret = deps?.resolveSecret;
    this._apiKeyRef = deps?.apiKeyRef;
    this._endpoint = deps?.endpoint ?? "https://api.exa.ai/search";
  }

  get authenticated(): boolean {
    return this._apiKeyRef !== undefined;
  }

  async health(): Promise<"available" | "authRequired" | "unavailable"> {
    if (!this._apiKeyRef || !this._resolveSecret) return "authRequired";
    try {
      const key = await this._resolveSecret(this._apiKeyRef);
      return key ? "available" : "authRequired";
    } catch {
      return "unavailable";
    }
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const policy = options?.policy ?? this._policy;
    // Abort/cancel inside try/catch so raw AbortErrors canonicalize.
    try {
      throwIfResearchAborted(options?.signal);
      const controller = createLinkedAbortController(options?.signal);
      return await this._searchWithTimeout(query, policy, options, controller);
    } catch (err: unknown) {
      throw toCanonicalResearchError(err);
    }
  }

  private async _searchWithTimeout(
    query: string,
    policy: ResearchPolicy,
    options: SearchOptions | undefined,
    controller: AbortController,
  ): Promise<SearchResult[]> {
    if (!this._apiKeyRef || !this._resolveSecret) {
      throw new ResearchAuthRequired(this.provider);
    }
    const apiKey = await this._resolveSecret(this._apiKeyRef);
    if (!apiKey) {
      throw new ResearchAuthRequired(this.provider);
    }
    const maxResults = Math.min(
      options?.maxResults ?? policy.maxSearchResults,
      policy.maxSearchResults,
    );
    return withResearchTimeout(
      this._searchInner(
        query.trim(),
        maxResults,
        apiKey,
        options?.fetchFn ?? this._fetchFn,
        controller.signal,
      ),
      policy.requestTimeoutMs,
      options?.signal,
      () => controller.abort(),
    );
  }

  private async _searchInner(
    query: string,
    maxResults: number,
    apiKey: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const response = await fetchFn(this._endpoint, {
      method: "POST",
      redirect: "manual",
      ...(signal ? { signal } : {}),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        query,
        numResults: maxResults,
        type: "auto",
        contents: { text: { maxCharacters: 1000 } },
      }),
    });
    if (response.status === 401 || response.status === 403) {
      throw new ResearchAuthRequired(this.provider, `Exa search rejected credentials`);
    }
    if (!response.ok) {
      throw new Error(`Exa search failed with status ${response.status}`);
    }
    const payload = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        publishedDate?: string;
        score?: number;
      }>;
    };
    const raw = Array.isArray(payload.results) ? payload.results : [];
    const normalized: SearchResult[] = [];
    for (const hit of raw.slice(0, maxResults)) {
      if (typeof hit.url !== "string" || hit.url.trim().length === 0) continue;
      const canonical = canonicalizeResearchUrl(hit.url);
      if (!canonical) continue;
      normalized.push({
        title: String(hit.title ?? canonical).slice(0, 300),
        url: canonical,
        snippet: String(hit.text ?? "").slice(0, 2000),
        domain: domainOf(canonical),
        ...(typeof hit.publishedDate === "string" && hit.publishedDate
          ? { publishedAt: hit.publishedDate }
          : {}),
        ...(typeof hit.score === "number" && Number.isFinite(hit.score)
          ? { score: hit.score }
          : {}),
      });
    }
    return dedupeSearchResults(normalized).slice(0, maxResults);
  }
}
