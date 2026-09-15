// PR35.10/35.20/35.23: apps/desktop — Research Service
//
// Invariants:
//   1. Owns the request lifecycle: cache lookup -> router dispatch ->
//      provenance-bound results -> bounded cache store. Concurrent outbound
//      adapter work is semaphore-bounded.
//   2. Browser fallback: static reader failure/insufficiency may route to
//      the existing PR34 BrowserService (open -> snapshot -> close) through
//      its public boundary. Research never imports Puppeteer or
//      BrowserManager; the fallback reports provider "browser" with the full
//      attempted trail.
//   3. Authenticated resources are never served from cache (cache.set
//      refuses them; the service also bypasses lookup when authenticated).
//   4. No secrets in outputs: API keys resolve via the injected SecretRef
//      resolver owned by main composition, never constructed here.

import {
  canonicalizeResearchUrl,
  createResearchDocumentId,
  createResearchRequestId,
  dedupeSearchResults,
  MAX_RESEARCH_TOOL_RESULT_BYTES,
  wrapUntrustedContent,
  type ResearchChannel,
  type ResearchDocument,
  type ResearchRequestId,
  type ResearchResult,
  type SearchResult,
} from "@ai-desktop/ai-core";
import {
  ResearchProviderError,
  ResearchUnavailable,
  toCanonicalResearchError,
} from "./research-errors.js";
import type { ResearchPolicy } from "./research-policy.js";
import { defaultResearchPolicy } from "./research-policy.js";
import { ResearchCache, researchCacheKey } from "./research-cache.js";
import { buildResearchSource, newResearchResultId } from "./research-provenance.js";
import { ResearchRouter } from "./routing/research-router.js";
import type { StaticWebReader, WebPageReader } from "./adapters/web/web-reader.js";
import type { SearchProvider } from "./adapters/search/search-provider.js";
import type { GithubResearchAdapter } from "./adapters/github/github-research.js";
import type { YoutubeResearchAdapter } from "./adapters/youtube/youtube-research.js";
import type { RssResearchAdapter } from "./adapters/rss/rss-research.js";

export interface BrowserFallbackLike {
  openAndSnapshot(
    url: string,
    options?: { signal?: AbortSignal; projectId?: string },
  ): Promise<{
    title: string;
    text: string;
    finalUrl: string;
  }>;
}

export interface ResearchServiceDeps {
  readonly policy?: ResearchPolicy;
  readonly router?: ResearchRouter;
  readonly cache?: ResearchCache<unknown>;
  readonly webReader?: WebPageReader;
  readonly searchProvider?: SearchProvider;
  readonly githubAdapter?: GithubResearchAdapter;
  readonly youtubeAdapter?: YoutubeResearchAdapter;
  readonly rssAdapter?: RssResearchAdapter;
  readonly browserFallback?: BrowserFallbackLike;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface ResearchCallOptions {
  readonly requestId?: ResearchRequestId;
  readonly maxResults?: number;
  readonly maxChars?: number;
  readonly maxItems?: number;
  readonly signal?: AbortSignal;
  readonly projectId?: string;
}

function byteLengthOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return MAX_RESEARCH_TOOL_RESULT_BYTES + 1;
  }
}

/** Host-owned research orchestration: cache -> adapters -> provenance. */
export class ResearchService {
  private readonly _policy: ResearchPolicy;
  private readonly _router: ResearchRouter;
  private readonly _cache: ResearchCache<unknown>;
  private readonly _webReader?: WebPageReader;
  private readonly _searchProvider?: SearchProvider;
  private readonly _githubAdapter?: GithubResearchAdapter;
  private readonly _youtubeAdapter?: YoutubeResearchAdapter;
  private readonly _rssAdapter?: RssResearchAdapter;
  private readonly _browserFallback?: BrowserFallbackLike;
  private readonly _fetchFn?: typeof fetch;
  private readonly _resolveAll?: ResearchServiceDeps["resolveAll"];
  private _inFlight = 0;
  private readonly _waiters: Array<() => void> = [];

  constructor(deps?: ResearchServiceDeps) {
    this._policy = deps?.policy ?? defaultResearchPolicy();
    this._router = deps?.router ?? new ResearchRouter();
    this._cache =
      deps?.cache ?? new ResearchCache<unknown>({ maxEntries: this._policy.maxCacheEntries });
    this._webReader = deps?.webReader;
    this._searchProvider = deps?.searchProvider;
    this._githubAdapter = deps?.githubAdapter;
    this._youtubeAdapter = deps?.youtubeAdapter;
    this._rssAdapter = deps?.rssAdapter;
    this._browserFallback = deps?.browserFallback;
    this._fetchFn = deps?.fetchFn;
    this._resolveAll = deps?.resolveAll;
    if (this._webReader) this._router.register("web", this._webReader);
    if (this._searchProvider) this._router.register("search", this._searchProvider);
    if (this._githubAdapter) this._router.register("github", this._githubAdapter);
    if (this._youtubeAdapter) this._router.register("youtube", this._youtubeAdapter);
    if (this._rssAdapter) this._router.register("rss", this._rssAdapter);
  }

  get router(): ResearchRouter {
    return this._router;
  }

  get cache(): ResearchCache<unknown> {
    return this._cache;
  }

  private async _acquireSlot(signal?: AbortSignal): Promise<void> {
    while (this._inFlight >= this._policy.maxConcurrentRequests) {
      if (signal?.aborted) {
        throw Object.assign(new Error("Research operation cancelled"), { name: "AbortError" });
      }
      await new Promise<void>((resolve) => this._waiters.push(resolve));
    }
    this._inFlight += 1;
  }

  private _releaseSlot(): void {
    this._inFlight = Math.max(0, this._inFlight - 1);
    const next = this._waiters.shift();
    if (next) next();
  }

  private async _bounded<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    await this._acquireSlot(signal);
    try {
      return await work();
    } finally {
      this._releaseSlot();
    }
  }

  private _cached<T>(channel: ResearchChannel, provider: string, input: string): T | undefined {
    const entry = this._cache.get(researchCacheKey(channel, provider, input));
    if (!entry || entry.authenticated) return undefined;
    return entry.payload as T;
  }

  private _store(
    channel: ResearchChannel,
    provider: string,
    input: string,
    payload: unknown,
  ): void {
    const nowMs = Date.now();
    this._cache.set({
      key: researchCacheKey(channel, provider, input),
      provider,
      channel,
      retrievedAt: nowMs,
      expiresAt: nowMs + this._policy.cacheTtlMs[channel],
      payload,
      authenticated: false,
    });
  }

  private _netOptions(signal?: AbortSignal) {
    return {
      ...(this._fetchFn ? { fetchFn: this._fetchFn } : {}),
      ...(this._resolveAll ? { resolveAll: this._resolveAll } : {}),
      ...(signal ? { signal } : {}),
      policy: this._policy,
    };
  }

  // -- web: static reader first, browser fallback on failure/insufficiency --

  async openWebPage(url: string, options?: ResearchCallOptions): Promise<ResearchResult> {
    const requestId = options?.requestId ?? createResearchRequestId();
    const signal = options?.signal;
    const reader = this._webReader as (WebPageReader & { provider: string }) | undefined;
    if (!reader || typeof (reader as StaticWebReader).read !== "function") {
      throw new ResearchUnavailable(`No web reader registered`);
    }
    const cacheInput = canonicalizeResearchUrl(url) ?? url.trim();
    const cached = this._cached<ResearchResult>("web", reader.provider, cacheInput);
    if (cached) return { ...cached, requestId };

    return this._bounded(signal, async () => {
      const attempted: string[] = [];
      let doc: ResearchDocument | undefined;
      let provider = reader.provider;
      try {
        attempted.push(reader.provider);
        doc = await reader.read(url, {
          requestId,
          ...(options?.maxChars ? { maxChars: options.maxChars } : {}),
          ...this._netOptions(signal),
        });
        if (isInsufficientDocument(doc) && this._browserFallback) {
          attempted.push("browser");
          provider = "browser";
          doc = await this._readViaBrowser(
            url,
            requestId,
            options?.maxChars,
            signal,
            options?.projectId,
          );
        }
      } catch (err: unknown) {
        if (this._browserFallback && isFallbackWorthy(err)) {
          attempted.push("browser");
          provider = "browser";
          doc = await this._readViaBrowser(
            url,
            requestId,
            options?.maxChars,
            signal,
            options?.projectId,
          );
        } else {
          throw toCanonicalResearchError(err);
        }
      }
      if (!doc) {
        throw new ResearchUnavailable(`Web page unavailable`);
      }
      const { source, retrievedAt } = buildResearchSource({
        provider,
        attemptedProviders: attempted,
        channel: "web",
        url: doc.canonicalUrl,
        ...(doc.title ? { title: doc.title } : {}),
        contentType: doc.mimeType,
      });
      const content = doc.text.slice(0, options?.maxChars ?? this._policy.maxContentChars);
      const result: ResearchResult = {
        id: newResearchResultId(),
        requestId,
        source,
        ...(doc.title ? { title: doc.title } : {}),
        url: doc.canonicalUrl,
        excerpt: content.slice(0, 1000),
        content: wrapUntrustedContent(content, source.provenance),
        retrievedAt,
        mimeType: doc.mimeType,
        truncated: doc.truncated || doc.text.length > content.length,
      };
      this._enforceToolResultCeiling(result);
      this._store("web", provider, cacheInput, result);
      return result;
    });
  }

  private async _readViaBrowser(
    url: string,
    requestId: ResearchRequestId,
    maxChars: number | undefined,
    signal?: AbortSignal,
    projectId?: string,
  ): Promise<ResearchDocument> {
    if (!this._browserFallback) {
      throw new ResearchUnavailable(`Browser fallback unavailable`);
    }
    const snapshot = await this._browserFallback.openAndSnapshot(url, {
      ...(signal ? { signal } : {}),
      ...(projectId ? { projectId } : {}),
    });
    const cap = maxChars ?? this._policy.maxContentChars;
    const text = snapshot.text.slice(0, this._policy.maxDocumentChars);
    return {
      id: createResearchDocumentId(),
      requestId,
      url,
      canonicalUrl: canonicalizeResearchUrl(snapshot.finalUrl) ?? snapshot.finalUrl,
      title: snapshot.title.slice(0, 300),
      text,
      mimeType: "text/plain",
      truncated: snapshot.text.length > cap,
      retrievedAt: new Date().toISOString(),
    };
  }

  // -- search --

  async searchWeb(query: string, options?: ResearchCallOptions): Promise<ResearchResult> {
    const requestId = options?.requestId ?? createResearchRequestId();
    const signal = options?.signal;
    if (!this._searchProvider) {
      throw new ResearchUnavailable(`No search provider registered`);
    }
    const provider = this._searchProvider;
    const cached = this._cached<ResearchResult>("search", provider.provider, query.trim());
    if (cached) return { ...cached, requestId };

    return this._bounded(signal, async () => {
      const routed = await this._router.route<SearchResult[]>(
        "search",
        async (adapter) => {
          const concrete = adapter as unknown as SearchProvider;
          if (typeof concrete.search !== "function") {
            throw new ResearchProviderError(adapter.provider, `Adapter cannot search`);
          }
          return concrete.search(query, {
            ...(options?.maxResults ? { maxResults: options.maxResults } : {}),
            ...this._netOptions(signal),
          });
        },
        { ...(signal ? { signal } : {}) },
      );
      const hits = dedupeSearchResults(routed.outcome).slice(0, this._policy.maxSearchResults);
      const { source, retrievedAt } = buildResearchSource({
        provider: routed.provider,
        attemptedProviders: routed.attemptedProviders,
        channel: "search",
      });
      const lines = hits.map((h) => `- ${h.title}\n  ${h.url}\n  ${h.snippet}`).join("\n");
      const result: ResearchResult = {
        id: newResearchResultId(),
        requestId,
        source,
        title: `Search: ${query.slice(0, 200)}`,
        excerpt: lines.slice(0, 1000),
        content: wrapUntrustedContent(lines, source.provenance),
        retrievedAt,
        mimeType: "application/json",
        metadata: { results: hits },
        truncated: false,
      };
      this._enforceToolResultCeiling(result);
      this._store("search", routed.provider, query.trim(), result);
      return result;
    });
  }

  // -- github --

  async readGithub(
    query: Parameters<GithubResearchAdapter["read"]>[0],
    options?: ResearchCallOptions,
  ): Promise<ResearchResult> {
    const requestId = options?.requestId ?? createResearchRequestId();
    const signal = options?.signal;
    if (!this._githubAdapter) {
      throw new ResearchUnavailable(`No GitHub adapter registered`);
    }
    const adapter = this._githubAdapter;
    const cacheInput = JSON.stringify(query);
    const authenticated = adapter.authenticated;
    const cached = authenticated
      ? undefined
      : this._cached<ResearchResult>("github", adapter.provider, cacheInput);
    if (cached) return { ...cached, requestId };

    return this._bounded(signal, async () => {
      const content = await adapter.read(query, {
        ...this._netOptions(signal),
        policy: this._policy,
      });
      const { source, retrievedAt } = buildResearchSource({
        provider: adapter.provider,
        channel: "github",
        url: content.url,
        title: content.title,
        contentType: "application/json",
      });
      const body = content.text.slice(0, options?.maxChars ?? this._policy.maxContentChars);
      const result: ResearchResult = {
        id: newResearchResultId(),
        requestId,
        source,
        title: content.title,
        url: content.url,
        excerpt: body.slice(0, 1000),
        content: wrapUntrustedContent(body, source.provenance),
        retrievedAt,
        mimeType: "application/json",
        ...(content.searchResults ? { metadata: { results: content.searchResults } } : {}),
        truncated: content.truncated,
      };
      this._enforceToolResultCeiling(result);
      if (!authenticated) this._store("github", adapter.provider, cacheInput, result);
      return result;
    });
  }

  // -- youtube --

  async readYoutube(
    query: Parameters<YoutubeResearchAdapter["read"]>[0],
    options?: ResearchCallOptions,
  ): Promise<ResearchResult> {
    const requestId = options?.requestId ?? createResearchRequestId();
    const signal = options?.signal;
    if (!this._youtubeAdapter) {
      throw new ResearchUnavailable(`No YouTube adapter registered`);
    }
    const adapter = this._youtubeAdapter;
    const cacheInput = JSON.stringify(query);
    const cached = this._cached<ResearchResult>("youtube", adapter.metadataProvider, cacheInput);
    if (cached && query.operation !== "search") return { ...cached, requestId };

    return this._bounded(signal, async () => {
      const content = await adapter.read(query, {
        ...this._netOptions(signal),
        policy: this._policy,
      });
      const { source, retrievedAt } = buildResearchSource({
        provider: content.provider,
        channel: "youtube",
        url: content.url,
        title: content.title,
      });
      const body = content.text.slice(0, options?.maxChars ?? this._policy.maxContentChars);
      const result: ResearchResult = {
        id: newResearchResultId(),
        requestId,
        source,
        title: content.title,
        url: content.url,
        excerpt: body.slice(0, 1000),
        content: wrapUntrustedContent(body, source.provenance),
        retrievedAt,
        ...(content.searchResults ? { metadata: { results: content.searchResults } } : {}),
        truncated: content.truncated,
      };
      this._enforceToolResultCeiling(result);
      if (query.operation !== "search")
        this._store("youtube", content.provider, cacheInput, result);
      return result;
    });
  }

  // -- rss --

  async readRssFeed(feedUrl: string, options?: ResearchCallOptions): Promise<ResearchResult> {
    const requestId = options?.requestId ?? createResearchRequestId();
    const signal = options?.signal;
    if (!this._rssAdapter) {
      throw new ResearchUnavailable(`No RSS adapter registered`);
    }
    const adapter = this._rssAdapter;
    const cacheInput = canonicalizeResearchUrl(feedUrl) ?? feedUrl.trim();
    const cached = this._cached<ResearchResult>("rss", adapter.provider, cacheInput);
    if (cached) return { ...cached, requestId };

    return this._bounded(signal, async () => {
      const feed = await adapter.read(feedUrl, {
        ...(options?.maxItems ? { maxItems: options.maxItems } : {}),
        ...this._netOptions(signal),
        policy: this._policy,
      });
      const { source, retrievedAt } = buildResearchSource({
        provider: adapter.provider,
        channel: "rss",
        url: feed.feedUrl,
        title: feed.title,
        contentType: "application/rss+xml",
      });
      const lines = feed.items
        .map((i) => `- ${i.title}\n  ${i.url}\n  ${i.summary}`)
        .join("\n")
        .slice(0, options?.maxChars ?? this._policy.maxContentChars);
      const result: ResearchResult = {
        id: newResearchResultId(),
        requestId,
        source,
        title: feed.title,
        url: feed.feedUrl,
        excerpt: lines.slice(0, 1000),
        content: wrapUntrustedContent(lines, source.provenance),
        retrievedAt,
        mimeType: "application/rss+xml",
        metadata: { items: feed.items },
        truncated: feed.truncated,
      };
      this._enforceToolResultCeiling(result);
      this._store("rss", adapter.provider, cacheInput, result);
      return result;
    });
  }

  private _enforceToolResultCeiling(result: ResearchResult): void {
    if (byteLengthOf(result) <= MAX_RESEARCH_TOOL_RESULT_BYTES) return;
    const overflow: ResearchResult = {
      ...result,
      content: wrapUntrustedContent(
        (result.excerpt ?? "").slice(0, 4000),
        result.source.provenance,
      ),
      metadata: undefined,
      truncated: true,
    };
    if (byteLengthOf(overflow) > MAX_RESEARCH_TOOL_RESULT_BYTES) {
      throw new ResearchProviderError("research", `Research result exceeds size ceiling`);
    }
    (result as { content?: string }).content = overflow.content;
    (result as { metadata?: unknown }).metadata = undefined;
    (result as { truncated: boolean }).truncated = true;
  }
}

/** Static reads yielding almost no text count as insufficient (JS shell). */
function isInsufficientDocument(doc: ResearchDocument): boolean {
  return doc.text.trim().length < 140;
}

const FALLBACK_WORTHY_CODES = new Set([
  "PROVIDER_ERROR",
  "UNAVAILABLE",
  "TIMEOUT",
  "UNSUPPORTED_MIME",
  "RESPONSE_TOO_LARGE",
]);

function isFallbackWorthy(err: unknown): boolean {
  if (err instanceof ResearchUnavailable) return true;
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  if (FALLBACK_WORTHY_CODES.has(code)) return true;
  if (
    err instanceof Error &&
    /\b(js-heavy|javascript required|empty document)\b/i.test(err.message)
  ) {
    return true;
  }
  return false;
}
