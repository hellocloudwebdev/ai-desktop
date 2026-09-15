// PR35.19: apps/desktop — YouTube Research Adapter
//
// Invariants:
//   1. metadata via public oEmbed (keyless). transcript via best-effort
//      caption-track discovery, degrading cleanly to unavailable with
//      provenance intact. search via YouTube Data API v3 (SecretRef key;
//      authRequired without one — no fragile HTML scraping).
//   2. No yt-dlp, no subprocess, no auto-install. Inputs are videoId/url
//      validated; nothing is interpolated into shell commands (there are
//      no shell commands).
//   3. Raw credentials never appear in outputs, errors, or logs.

import {
  canonicalizeResearchUrl,
  dedupeSearchResults,
  type SearchResult,
} from "@ai-desktop/ai-core";
import {
  ResearchAuthRequired,
  ResearchNotFound,
  ResearchProviderError,
  ResearchUnavailable,
  toCanonicalResearchError,
} from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import {
  createLinkedAbortController,
  defaultResearchPolicy,
  throwIfResearchAborted,
  withResearchTimeout,
} from "../../research-policy.js";
import { fetchWithRedirectPolicy } from "../../security/redirect-policy.js";
import { checkResearchUrl } from "../../security/url-policy.js";

export type YoutubeOperation = "metadata" | "transcript" | "search";

export interface YoutubeQuery {
  readonly operation: YoutubeOperation;
  readonly videoId?: string;
  readonly url?: string;
  readonly query?: string;
  readonly maxResults?: number;
}

export interface YoutubeReadOptions {
  readonly signal?: AbortSignal;
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface YoutubeResultContent {
  readonly kind: YoutubeOperation;
  readonly provider: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly searchResults?: SearchResult[];
}

export interface YoutubeResearchDeps {
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: YoutubeReadOptions["resolveAll"];
  readonly resolveSecret?: (ref: string) => Promise<string | null>;
  readonly apiKeyRef?: string;
}

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function extractYoutubeVideoId(input: { videoId?: string; url?: string }): string | null {
  if (input.videoId && VIDEO_ID_PATTERN.test(input.videoId.trim())) {
    return input.videoId.trim();
  }
  if (input.url) {
    try {
      const parsed = new URL(input.url.trim());
      const host = parsed.hostname.toLowerCase();
      if (host === "youtu.be") {
        const id = parsed.pathname.slice(1).split("/")[0] ?? "";
        return VIDEO_ID_PATTERN.test(id) ? id : null;
      }
      if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
        const v = parsed.searchParams.get("v");
        if (v && VIDEO_ID_PATTERN.test(v)) return v;
        const shorts = /^\/shorts\/([^/]+)/.exec(parsed.pathname);
        if (shorts?.[1] && VIDEO_ID_PATTERN.test(shorts[1])) return shorts[1];
        const embed = /^\/embed\/([^/]+)/.exec(parsed.pathname);
        if (embed?.[1] && VIDEO_ID_PATTERN.test(embed[1])) return embed[1];
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** YouTube adapter: oEmbed metadata, caption transcripts, Data API search. */
export class YoutubeResearchAdapter {
  readonly provider = "youtube-oembed";
  private readonly _policy: ResearchPolicy;
  private readonly _fetchFn?: typeof fetch;
  private readonly _resolveAll?: YoutubeReadOptions["resolveAll"];
  private readonly _resolveSecret?: (ref: string) => Promise<string | null>;
  private readonly _apiKeyRef?: string;

  constructor(deps?: YoutubeResearchDeps) {
    this._policy = deps?.policy ?? defaultResearchPolicy();
    this._fetchFn = deps?.fetchFn;
    this._resolveAll = deps?.resolveAll;
    this._resolveSecret = deps?.resolveSecret;
    this._apiKeyRef = deps?.apiKeyRef;
  }

  get metadataProvider(): string {
    return "youtube-oembed";
  }

  get authenticated(): boolean {
    return this._apiKeyRef !== undefined;
  }

  async health(): Promise<"available" | "authRequired" | "unavailable"> {
    return "available";
  }

  async read(query: YoutubeQuery, options?: YoutubeReadOptions): Promise<YoutubeResultContent> {
    const policy = options?.policy ?? this._policy;
    // Abort/cancel inside try/catch so raw AbortErrors canonicalize.
    try {
      throwIfResearchAborted(options?.signal);
      const controller = createLinkedAbortController(options?.signal);
      return await withResearchTimeout(
        this._readInner(query, policy, controller.signal),
        policy.requestTimeoutMs,
        options?.signal,
        () => controller.abort(),
      );
    } catch (err: unknown) {
      throw toCanonicalResearchError(err);
    }
  }

  private _net(policy: ResearchPolicy, signal?: AbortSignal) {
    return {
      maxRedirects: policy.maxRedirects,
      ...(this._fetchFn ? { fetchFn: this._fetchFn } : {}),
      ...(this._resolveAll ? { resolveAll: this._resolveAll } : {}),
      denyLoopback: policy.denyLoopback,
      ...(policy.allowedHosts ? { allowedHosts: [...policy.allowedHosts] } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  private async _readInner(
    query: YoutubeQuery,
    policy: ResearchPolicy,
    signal?: AbortSignal,
  ): Promise<YoutubeResultContent> {
    switch (query.operation) {
      case "metadata": {
        const videoId = extractYoutubeVideoId(query);
        if (!videoId) {
          throw new ResearchProviderError(
            "youtube-oembed",
            `YouTube metadata requires videoId or watch URL`,
          );
        }
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const { response } = await fetchWithRedirectPolicy(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
          this._net(policy, signal),
        );
        if (response.status === 404) {
          throw new ResearchNotFound(`YouTube video "${videoId}" not found`);
        }
        if (!response.ok) {
          throw new ResearchProviderError(
            "youtube-oembed",
            `YouTube oEmbed failed with status ${response.status}`,
          );
        }
        const data = (await response.json()) as Record<string, unknown>;
        const title = typeof data.title === "string" ? data.title : watchUrl;
        const author = typeof data.author_name === "string" ? data.author_name : "";
        const text = [`Title: ${title}`, author ? `Author: ${author}` : "", `URL: ${watchUrl}`]
          .filter(Boolean)
          .join("\n");
        return {
          kind: "metadata",
          provider: "youtube-oembed",
          url: watchUrl,
          title: title.slice(0, 300),
          text: text.slice(0, policy.maxContentChars),
          truncated: text.length > policy.maxContentChars,
        };
      }
      case "transcript": {
        const videoId = extractYoutubeVideoId(query);
        if (!videoId) {
          throw new ResearchProviderError(
            "youtube-oembed",
            `YouTube transcript requires videoId or watch URL`,
          );
        }
        const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const captionTracks = await this._discoverCaptionTracks(watchUrl, policy, signal);
        if (captionTracks.length === 0) {
          throw new ResearchUnavailable(`No captions available for YouTube video "${videoId}"`);
        }
        const trackUrl = captionTracks[0]!;
        const gate = checkResearchUrl(trackUrl);
        if (!gate.allowed) {
          throw new ResearchUnavailable(`YouTube caption track URL rejected`);
        }
        const { response } = await fetchWithRedirectPolicy(trackUrl, this._net(policy, signal));
        if (!response.ok) {
          throw new ResearchUnavailable(
            `YouTube transcript fetch failed with status ${response.status}`,
          );
        }
        const xml = await response.text();
        const text = decodeTimedText(xml).slice(0, policy.maxContentChars);
        return {
          kind: "transcript",
          provider: "youtube-oembed",
          url: watchUrl,
          title: `Transcript: ${videoId}`,
          text,
          truncated: text.length >= policy.maxContentChars,
        };
      }
      case "search": {
        if (!query.query) {
          throw new ResearchProviderError("youtube-api", `YouTube search requires query`);
        }
        if (!this._apiKeyRef || !this._resolveSecret) {
          throw new ResearchAuthRequired("youtube-api");
        }
        const apiKey = await this._resolveSecret(this._apiKeyRef);
        if (!apiKey) {
          throw new ResearchAuthRequired("youtube-api");
        }
        const maxResults = Math.min(
          query.maxResults ?? policy.maxSearchResults,
          policy.maxSearchResults,
        );
        const endpoint =
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
          `&maxResults=${maxResults}&q=${encodeURIComponent(query.query)}`;
        const { response } = await fetchWithRedirectPolicy(endpoint, {
          ...this._net(policy, signal),
          headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) {
          throw new ResearchAuthRequired("youtube-api", `YouTube Data API rejected credentials`);
        }
        if (!response.ok) {
          throw new ResearchProviderError(
            "youtube-api",
            `YouTube search failed with status ${response.status}`,
          );
        }
        const payload = (await response.json()) as {
          items?: Array<{
            id?: { videoId?: string };
            snippet?: {
              title?: string;
              description?: string;
              publishedAt?: string;
              channelTitle?: string;
            };
          }>;
        };
        const results: SearchResult[] = [];
        for (const item of (payload.items ?? []).slice(0, maxResults)) {
          const id = item.id?.videoId;
          if (!id || !VIDEO_ID_PATTERN.test(id)) continue;
          const watchUrl = `https://www.youtube.com/watch?v=${id}`;
          const canonical = canonicalizeResearchUrl(watchUrl) ?? watchUrl;
          results.push({
            title: String(item.snippet?.title ?? id).slice(0, 300),
            url: canonical,
            snippet: String(item.snippet?.description ?? "").slice(0, 2000),
            domain: "youtube.com",
            ...(item.snippet?.publishedAt ? { publishedAt: item.snippet.publishedAt } : {}),
          });
        }
        const deduped = dedupeSearchResults(results).slice(0, maxResults);
        const text = deduped
          .map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`)
          .join("\n")
          .slice(0, policy.maxContentChars);
        return {
          kind: "search",
          provider: "youtube-api",
          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query.query)}`,
          title: `YouTube search: ${query.query}`,
          text,
          truncated: false,
          searchResults: deduped,
        };
      }
    }
  }

  /** Best-effort caption-track discovery from the watch page embed data. */
  private async _discoverCaptionTracks(
    watchUrl: string,
    policy: ResearchPolicy,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const { response } = await fetchWithRedirectPolicy(watchUrl, this._net(policy, signal));
    if (!response.ok) return [];
    const html = await response.text();
    const tracks: string[] = [];
    const captionRegex = /"captionTracks":\s*\[([\s\S]*?)\]/;
    const match = captionRegex.exec(html.slice(0, 500000));
    if (match?.[1]) {
      const urlRegex = /"baseUrl":\s*"([^"]+)"/g;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlRegex.exec(match[1])) !== null) {
        try {
          tracks.push(JSON.parse(`"${urlMatch[1]}"`));
        } catch {
          // Skip malformed escapes; discovery is best-effort.
        }
      }
    }
    return tracks;
  }
}

/** Decodes YouTube timedtext XML (<text> elements) into plain lines. */
export function decodeTimedText(xml: string): string {
  const lines: string[] = [];
  const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(xml.slice(0, 1000000))) !== null) {
    const decoded = (match[1] ?? "")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (decoded) lines.push(decoded);
  }
  return lines.join("\n");
}
