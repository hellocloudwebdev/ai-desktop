// PR35: apps/desktop — YouTube Research Adapter
//
// Structured public YouTube research without subprocesses or API keys:
// metadata via the oEmbed endpoint and transcripts via the public timedtext
// caption track. Search returns scoped watch URLs for later opening.
// Never auto-installs yt-dlp; never passes model strings to a shell.

import type { ResearchChannel } from "@ai-desktop/ai-core";
import { MAX_SEARCH_RESULTS } from "@ai-desktop/ai-core";
import { ResearchCancelled, ResearchProviderFailed } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "../../research-policy.js";
import { secureFetch } from "../../security/secure-fetch.js";
import type { DnsResolver } from "../../security/ssrf-guard.js";
import type {
  AdapterContext,
  ResearchAdapter,
  YoutubeArgs,
  YoutubeOutput,
  YoutubeResearchItem,
} from "../adapter.js";

export const YOUTUBE_ADAPTER_PROVIDER = "youtube-adapter";

export interface YoutubeAdapterDeps {
  readonly policy?: ResearchPolicy;
  readonly resolver?: DnsResolver;
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function boundLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    return 10;
  }
  return Math.min(Math.floor(limit), MAX_SEARCH_RESULTS);
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function stripCaptionMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export class YoutubeResearchAdapter implements ResearchAdapter {
  readonly provider = YOUTUBE_ADAPTER_PROVIDER;
  readonly channel: ResearchChannel = "youtube";
  private readonly _policy: ResearchPolicy;
  private readonly _resolver?: DnsResolver;

  constructor(deps: YoutubeAdapterDeps = {}) {
    this._policy = deps.policy ?? DEFAULT_RESEARCH_POLICY;
    this._resolver = deps.resolver;
  }

  async readYoutube(args: YoutubeArgs, ctx: AdapterContext): Promise<YoutubeOutput> {
    if (args.videoId) {
      if (!VIDEO_ID_PATTERN.test(args.videoId)) {
        throw new ResearchProviderFailed(YOUTUBE_ADAPTER_PROVIDER, "Invalid YouTube video ID");
      }
      const item = await this._readVideo(args.videoId, args.includeTranscript, ctx);
      return { results: [item] };
    }
    if (args.query) {
      return { results: this._searchScope(args.query, boundLimit(args.limit)) };
    }
    throw new ResearchProviderFailed(
      YOUTUBE_ADAPTER_PROVIDER,
      "Provide a videoId or a search query",
    );
  }

  private async _readVideo(
    videoId: string,
    includeTranscript: boolean,
    ctx: AdapterContext,
  ): Promise<YoutubeResearchItem> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const fetched = await secureFetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(videoId))}&format=json`,
      {
        policy: this._policy,
        ...(this._resolver ? { resolver: this._resolver } : {}),
        ...(this._policy.allowedHosts
          ? { allowlist: { allowedHosts: this._policy.allowedHosts } }
          : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    let title = videoId;
    let channelTitle: string | undefined;
    try {
      const data = JSON.parse(fetched.body.toString("utf-8")) as Record<string, unknown>;
      if (typeof data["title"] === "string" && data["title"]) {
        title = data["title"].slice(0, 300);
      }
      if (typeof data["author_name"] === "string" && data["author_name"]) {
        channelTitle = data["author_name"].slice(0, 200);
      }
    } catch {
      // oEmbed decode failure: keep ID-based fallback.
    }
    let transcript: string | undefined;
    if (includeTranscript) {
      transcript = await this._readCaptions(videoId, ctx);
    }
    return {
      videoId,
      title,
      url: watchUrl(videoId),
      snippet: channelTitle ? `By ${channelTitle}` : "",
      ...(channelTitle ? { channelTitle } : {}),
      ...(transcript ? { transcript: transcript.slice(0, 10000) } : {}),
    };
  }

  private async _readCaptions(videoId: string, ctx: AdapterContext): Promise<string | undefined> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    // Public timedtext caption endpoint (English, then auto-generated).
    const candidates = [
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`,
    ];
    for (const endpoint of candidates) {
      try {
        const fetched = await secureFetch(endpoint, {
          policy: this._policy,
          ...(this._resolver ? { resolver: this._resolver } : {}),
          ...(this._policy.allowedHosts
            ? { allowlist: { allowedHosts: this._policy.allowedHosts } }
            : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const xml = fetched.body.toString("utf-8");
        const texts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)]
          .map((m) => stripCaptionMarkup(m[1] ?? ""))
          .filter((t) => t.length > 0);
        if (texts.length > 0) {
          return texts.join(" ").slice(0, 10000);
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private _searchScope(query: string, limit: number): YoutubeResearchItem[] {
    // Host has no YouTube Data API key in PR35: return a scoped search URL
    // item so the agent can open the results page explicitly.
    if (!query.trim()) {
      return [];
    }
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim().slice(0, 200))}`;
    return [
      {
        title: `YouTube search: ${query.trim().slice(0, 200)}`,
        url,
        snippet: "Open this YouTube search page to inspect results.",
      },
    ].slice(0, limit);
  }
}
