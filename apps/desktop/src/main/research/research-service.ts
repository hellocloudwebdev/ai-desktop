// PR35: apps/desktop — Research Service
//
// Orchestrates research requests: cache lookup -> router dispatch ->
// provenance assembly -> bounded ResearchResult construction -> cache store.
// research.open falls back to the PR34 BrowserService (open + snapshot)
// when the static reader yields empty/insufficient text. Browser is used
// strictly through the BrowserService boundary — never Puppeteer directly.

import {
  canonicalizeResearchUrl,
  createResearchDocumentId,
  createResearchRequestId,
  createResearchResultId,
  createResearchSourceId,
  MAX_RESEARCH_CACHE_ENTRIES,
  type ResearchActionType,
  type ResearchChannel,
  type ResearchDocument,
  type ResearchProviderStatus,
  type ResearchResult,
  type ResearchSource,
} from "@ai-desktop/ai-core";
import { createTimestamp, type ToolCallId } from "@ai-desktop/shared";
import type { BrowserService } from "../browser/browser-service.js";
import type { AdapterContext } from "./adapters/adapter.js";
import { WEB_READER_PROVIDER } from "./adapters/web/web-reader.js";
import { buildResearchCacheKey, ResearchCache } from "./research-cache.js";
import {
  ResearchCancelled,
  ResearchProviderFailed,
  toCanonicalResearchError,
} from "./research-errors.js";
import type { ResearchPolicy } from "./research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "./research-policy.js";
import { buildProvenance, ResearchProviderHealth } from "./research-provenance.js";
import { ResearchRouter } from "./routing/research-router.js";

export const BROWSER_FALLBACK_PROVIDER = "browser-fallback";

export interface ResearchServiceDeps {
  readonly router: ResearchRouter;
  readonly policy?: ResearchPolicy;
  readonly cache?: ResearchCache<unknown>;
  readonly health?: ResearchProviderHealth;
  readonly browserService?: BrowserService;
}

export interface ResearchExecutionContext {
  readonly projectId: string;
  readonly toolCallId: ToolCallId;
  readonly signal?: AbortSignal;
}

export interface OpenOptions {
  readonly maxChars?: number;
  readonly fallbackToBrowser?: boolean;
}

export interface SearchOptions {
  readonly limit?: number;
}

export interface GithubOptions {
  readonly query?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly path?: string;
  readonly kind?: "repository" | "file" | "issue" | "search";
  readonly limit?: number;
}

export interface YoutubeOptions {
  readonly videoId?: string;
  readonly query?: string;
  readonly includeTranscript?: boolean;
  readonly limit?: number;
}

export interface RssOptions {
  readonly limit?: number;
}

function adapterContext(requestId: string, signal?: AbortSignal): AdapterContext {
  return {
    requestId,
    ...(signal ? { signal } : {}),
  };
}

export class ResearchService {
  private readonly _router: ResearchRouter;
  private readonly _policy: ResearchPolicy;
  private readonly _cache: ResearchCache<unknown>;
  private readonly _health: ResearchProviderHealth;
  private readonly _browserService?: BrowserService;

  constructor(deps: ResearchServiceDeps) {
    this._router = deps.router;
    this._policy = deps.policy ?? DEFAULT_RESEARCH_POLICY;
    this._cache =
      deps.cache ?? new ResearchCache<unknown>({ maxEntries: MAX_RESEARCH_CACHE_ENTRIES });
    this._health = deps.health ?? new ResearchProviderHealth();
    this._browserService = deps.browserService;
  }

  get health(): ResearchProviderHealth {
    return this._health;
  }

  get cache(): ResearchCache<unknown> {
    return this._cache;
  }

  providerStatus(provider: string): ResearchProviderStatus {
    return this._health.getStatus(provider);
  }

  private _cached<T>(key: string): T | undefined {
    const entry = this._cache.get(key);
    return entry ? (entry.payload as T) : undefined;
  }

  private _store(key: string, channel: ResearchChannel, provider: string, payload: unknown): void {
    this._cache.set(key, channel, provider, payload);
  }

  private _source(
    channel: ResearchChannel,
    provider: string,
    attempted: readonly string[],
    url: string | undefined,
    title: string | undefined,
    contentType: string | undefined,
    cached: boolean,
    publishedAt?: string,
  ): ResearchSource {
    const retrievedAt = createTimestamp();
    return {
      id: createResearchSourceId(),
      channel,
      provider,
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
      retrievedAt,
      ...(publishedAt ? { publishedAt: publishedAt as ResearchSource["publishedAt"] } : {}),
      ...(contentType ? { contentType } : {}),
      provenance: buildProvenance({
        provider,
        channel,
        ...(url ? { sourceUrl: url } : {}),
        retrievedAt,
        ...(publishedAt ? { publishedAt: publishedAt as never } : {}),
        attemptedProviders: attempted,
        cached,
      }),
    };
  }

  private _result(
    requestId: string,
    source: ResearchSource,
    fields: {
      title?: string;
      url?: string;
      excerpt?: string;
      content?: string;
      publishedAt?: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
      truncated: boolean;
    },
  ): ResearchResult {
    return {
      id: createResearchResultId(),
      requestId: requestId as ResearchResult["requestId"],
      source,
      ...(fields.title ? { title: fields.title } : {}),
      ...(fields.url ? { url: fields.url } : {}),
      ...(fields.excerpt ? { excerpt: fields.excerpt } : {}),
      ...(fields.content ? { content: fields.content } : {}),
      ...(fields.publishedAt ? { publishedAt: fields.publishedAt as never } : {}),
      retrievedAt: source.retrievedAt,
      ...(fields.mimeType ? { mimeType: fields.mimeType } : {}),
      ...(fields.metadata ? { metadata: fields.metadata } : {}),
      truncated: fields.truncated,
    };
  }

  async search(
    query: string,
    options: SearchOptions,
    ctx: ResearchExecutionContext,
  ): Promise<ResearchResult[]> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const requestId = createResearchRequestId();
    const limit = Math.min(Math.max(options.limit ?? 10, 1), this._policy.maxSearchResults);
    const key = buildResearchCacheKey({ op: "search", query, limit });
    const hit = this._cached<ResearchResult[]>(key);
    if (hit) {
      return hit.map((r) => ({
        ...r,
        source: {
          ...r.source,
          provenance: { ...r.source.provenance, cached: true },
        },
      }));
    }
    try {
      const routed = await this._router.routeSearch(
        query,
        limit,
        adapterContext(requestId, ctx.signal),
      );
      this._health.reportSuccess(routed.provider);
      const results = routed.output.results
        .slice(0, limit)
        .map(
          (item: {
            title: string;
            url: string;
            snippet: string;
            domain: string;
            score?: number;
            publishedAt?: string;
          }) =>
            this._result(
              requestId,
              this._source(
                "search",
                routed.provider,
                routed.attemptedProviders,
                item.url,
                item.title,
                undefined,
                false,
                item.publishedAt,
              ),
              {
                title: item.title,
                url: item.url,
                excerpt: item.snippet,
                publishedAt: item.publishedAt,
                metadata: {
                  domain: item.domain,
                  ...(item.score !== undefined ? { score: item.score } : {}),
                },
                truncated: false,
              },
            ),
        );
      this._store(key, "search", routed.provider, results);
      return results;
    } catch (err) {
      this._health.reportFailure("search", err instanceof Error ? err.message : String(err));
      throw toCanonicalResearchError(err, "search");
    }
  }

  async open(
    url: string,
    options: OpenOptions,
    ctx: ResearchExecutionContext,
  ): Promise<ResearchResult> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const requestId = createResearchRequestId();
    const key = buildResearchCacheKey({ op: "open", url, maxChars: options.maxChars ?? null });
    const hit = this._cached<ResearchResult>(key);
    if (hit) {
      return {
        ...hit,
        source: { ...hit.source, provenance: { ...hit.source.provenance, cached: true } },
      };
    }
    const maxChars = Math.min(
      options.maxChars ?? this._policy.maxDocumentChars,
      this._policy.maxDocumentChars,
    );
    try {
      const routed = await this._router.routeWeb(url, adapterContext(requestId, ctx.signal));
      this._health.reportSuccess(routed.provider);
      const doc = routed.output.document;
      const text = doc.text.length > maxChars ? doc.text.slice(0, maxChars) : doc.text;
      const truncated = doc.truncated || doc.text.length > maxChars;
      // Browser fallback when the static reader yields nothing useful.
      if (!text.trim() && options.fallbackToBrowser !== false && this._browserService) {
        return await this._openViaBrowser(url, requestId, routed.attemptedProviders, maxChars, ctx);
      }
      const source = this._source(
        "web",
        routed.provider,
        routed.attemptedProviders,
        doc.url,
        doc.title || undefined,
        doc.mimeType,
        false,
      );
      const result = this._result(requestId, source, {
        ...(doc.title ? { title: doc.title } : {}),
        url: doc.url,
        excerpt: text.slice(0, 2000),
        content: text,
        mimeType: doc.mimeType,
        metadata: {
          ...(doc.canonicalUrl ? { canonicalUrl: doc.canonicalUrl } : {}),
          attemptedProviders: routed.attemptedProviders,
        },
        truncated,
      });
      this._store(key, "web", routed.provider, result);
      return result;
    } catch (err) {
      if (ctx.signal?.aborted) {
        throw new ResearchCancelled();
      }
      // Static failure -> optional single browser-fallback attempt.
      if (options.fallbackToBrowser !== false && this._browserService) {
        try {
          return await this._openViaBrowser(url, requestId, [WEB_READER_PROVIDER], maxChars, ctx);
        } catch {
          // Fall through to the canonical static error below.
        }
      }
      this._health.reportFailure(
        WEB_READER_PROVIDER,
        err instanceof Error ? err.message : String(err),
      );
      throw toCanonicalResearchError(err, WEB_READER_PROVIDER);
    }
  }

  private async _openViaBrowser(
    url: string,
    requestId: string,
    attempted: readonly string[],
    maxChars: number,
    ctx: ResearchExecutionContext,
  ): Promise<ResearchResult> {
    const browser = this._browserService;
    if (!browser) {
      throw new ResearchProviderFailed(BROWSER_FALLBACK_PROVIDER, "Browser fallback unavailable");
    }
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const timeoutMs = this._policy.timeouts.browserFallbackTimeoutMs;
    const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new ResearchProviderFailed(
                    BROWSER_FALLBACK_PROVIDER,
                    "Browser fallback timed out",
                  ),
                ),
              timeoutMs,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
    let canonical = url;
    try {
      canonical = canonicalizeResearchUrl(url);
    } catch {
      canonical = url;
    }
    const session = await withTimeout(browser.getOrCreateSession(ctx.projectId));
    const page = await withTimeout(browser.manager.openPage(session.id, { url: canonical }));
    try {
      const snapshot = (await withTimeout(browser.manager.snapshot(page.id))) as {
        text?: unknown;
        title?: unknown;
        url?: unknown;
      };
      const rawText = typeof snapshot.text === "string" ? snapshot.text : "";
      const title = typeof snapshot.title === "string" ? snapshot.title : "";
      const pageUrl = typeof snapshot.url === "string" ? snapshot.url : canonical;
      const text = rawText.length > maxChars ? rawText.slice(0, maxChars) : rawText;
      const attemptedProviders = [...attempted, BROWSER_FALLBACK_PROVIDER];
      this._health.reportSuccess(BROWSER_FALLBACK_PROVIDER);
      const source = this._source(
        "web",
        BROWSER_FALLBACK_PROVIDER,
        attemptedProviders,
        pageUrl,
        title || undefined,
        "text/plain",
        false,
      );
      const result = this._result(requestId, source, {
        ...(title ? { title: title.slice(0, 500) } : {}),
        url: pageUrl,
        excerpt: text.slice(0, 2000),
        content: text,
        mimeType: "text/plain",
        metadata: { attemptedProviders, fallback: true },
        truncated: rawText.length > maxChars,
      });
      const key = buildResearchCacheKey({ op: "open", url, maxChars: null });
      this._store(key, "web", BROWSER_FALLBACK_PROVIDER, result);
      return result;
    } finally {
      await browser.manager.closePage(page.id).catch(() => undefined);
    }
  }

  async readGithub(
    options: GithubOptions,
    ctx: ResearchExecutionContext,
  ): Promise<ResearchResult[]> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const requestId = createResearchRequestId();
    const limit = Math.min(Math.max(options.limit ?? 10, 1), this._policy.maxSearchResults);
    const key = buildResearchCacheKey({ op: "github", ...options, limit });
    const hit = this._cached<ResearchResult[]>(key);
    if (hit) {
      return hit;
    }
    try {
      const routed = await this._router.routeGithub(
        {
          ...(options.query ? { query: options.query } : {}),
          ...(options.owner ? { owner: options.owner } : {}),
          ...(options.repo ? { repo: options.repo } : {}),
          ...(options.path ? { path: options.path } : {}),
          kind: options.kind ?? "repository",
          limit,
        },
        adapterContext(requestId, ctx.signal),
      );
      this._health.reportSuccess(routed.provider);
      const results = routed.output.results
        .slice(0, limit)
        .map(
          (item: {
            kind: string;
            title: string;
            url: string;
            snippet: string;
            owner?: string;
            repo?: string;
            path?: string;
          }) =>
            this._result(
              requestId,
              this._source(
                "github",
                routed.provider,
                routed.attemptedProviders,
                item.url,
                item.title,
                undefined,
                false,
              ),
              {
                title: item.title,
                url: item.url,
                excerpt: item.snippet,
                content: item.snippet,
                metadata: {
                  kind: item.kind,
                  ...(item.owner ? { owner: item.owner } : {}),
                  ...(item.repo ? { repo: item.repo } : {}),
                  ...(item.path ? { path: item.path } : {}),
                },
                truncated: false,
              },
            ),
        );
      this._store(key, "github", routed.provider, results);
      return results;
    } catch (err) {
      this._health.reportFailure("github-api", err instanceof Error ? err.message : String(err));
      throw toCanonicalResearchError(err, "github-api");
    }
  }

  async readYoutube(
    options: YoutubeOptions,
    ctx: ResearchExecutionContext,
  ): Promise<ResearchResult[]> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const requestId = createResearchRequestId();
    const limit = Math.min(Math.max(options.limit ?? 10, 1), this._policy.maxSearchResults);
    const key = buildResearchCacheKey({ op: "youtube", ...options, limit });
    const hit = this._cached<ResearchResult[]>(key);
    if (hit) {
      return hit;
    }
    try {
      const routed = await this._router.routeYoutube(
        {
          ...(options.videoId ? { videoId: options.videoId } : {}),
          ...(options.query ? { query: options.query } : {}),
          includeTranscript: options.includeTranscript ?? false,
          limit,
        },
        adapterContext(requestId, ctx.signal),
      );
      this._health.reportSuccess(routed.provider);
      const results = routed.output.results
        .slice(0, limit)
        .map(
          (item: {
            videoId?: string;
            title: string;
            url: string;
            snippet: string;
            channelTitle?: string;
            publishedAt?: string;
            transcript?: string;
          }) =>
            this._result(
              requestId,
              this._source(
                "youtube",
                routed.provider,
                routed.attemptedProviders,
                item.url,
                item.title,
                undefined,
                false,
                item.publishedAt,
              ),
              {
                title: item.title,
                url: item.url,
                excerpt: item.snippet,
                ...(item.transcript ? { content: item.transcript } : {}),
                publishedAt: item.publishedAt,
                metadata: {
                  ...(item.videoId ? { videoId: item.videoId } : {}),
                  ...(item.channelTitle ? { channelTitle: item.channelTitle } : {}),
                },
                truncated: (item.transcript?.length ?? 0) >= 10000,
              },
            ),
        );
      this._store(key, "youtube", routed.provider, results);
      return results;
    } catch (err) {
      this._health.reportFailure(
        "youtube-adapter",
        err instanceof Error ? err.message : String(err),
      );
      throw toCanonicalResearchError(err, "youtube-adapter");
    }
  }

  async readRss(
    feedUrl: string,
    options: RssOptions,
    ctx: ResearchExecutionContext,
  ): Promise<ResearchResult[]> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const requestId = createResearchRequestId();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), this._policy.maxRssItems);
    const key = buildResearchCacheKey({ op: "rss", feedUrl, limit });
    const hit = this._cached<ResearchResult[]>(key);
    if (hit) {
      return hit;
    }
    try {
      const routed = await this._router.routeRss(
        feedUrl,
        limit,
        adapterContext(requestId, ctx.signal),
      );
      this._health.reportSuccess(routed.provider);
      const results = routed.output.items
        .slice(0, limit)
        .map(
          (item: {
            title: string;
            url: string;
            summary: string;
            publishedAt?: string;
            author?: string;
          }) =>
            this._result(
              requestId,
              this._source(
                "rss",
                routed.provider,
                routed.attemptedProviders,
                item.url,
                item.title,
                undefined,
                false,
                item.publishedAt,
              ),
              {
                title: item.title,
                url: item.url,
                excerpt: item.summary,
                content: item.summary,
                publishedAt: item.publishedAt,
                metadata: {
                  ...(item.author ? { author: item.author } : {}),
                  ...(routed.output.feedTitle ? { feedTitle: routed.output.feedTitle } : {}),
                },
                truncated: false,
              },
            ),
        );
      this._store(key, "rss", routed.provider, results);
      return results;
    } catch (err) {
      this._health.reportFailure("rss", err instanceof Error ? err.message : String(err));
      throw toCanonicalResearchError(err, "rss");
    }
  }

  actionForTool(toolName: string): ResearchActionType {
    switch (toolName) {
      case "builtin:research.search":
        return "search";
      case "builtin:research.open":
        return "open";
      case "builtin:research.github":
        return "github";
      case "builtin:research.youtube":
        return "youtube";
      case "builtin:research.rss":
        return "rss";
      default:
        throw new ResearchProviderFailed(undefined, `Unknown research tool "${toolName}"`);
    }
  }

  /** Test helper: builds a bounded empty document record. */
  static emptyDocument(url: string, requestId: string): ResearchDocument {
    return {
      id: createResearchDocumentId(),
      requestId: requestId as ResearchDocument["requestId"],
      url,
      title: "",
      text: "",
      mimeType: "text/html",
      truncated: false,
      retrievedAt: createTimestamp(),
      provider: WEB_READER_PROVIDER,
      attemptedProviders: [WEB_READER_PROVIDER],
    };
  }
}
