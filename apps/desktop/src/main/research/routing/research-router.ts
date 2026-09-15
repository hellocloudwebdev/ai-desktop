// PR35: apps/desktop — Research Router
//
// Controlled provider routing: primary -> fallback among explicitly
// registered host adapters. Every dispatch returns the attempted-provider
// ledger so provenance never hides a fallback.

import type { ResearchChannel, ResearchDocument } from "@ai-desktop/ai-core";
import { ResearchProviderFailed } from "../research-errors.js";
import type {
  AdapterContext,
  GithubArgs,
  GithubOutput,
  ResearchAdapter,
  RssOutput,
  SearchOutput,
  WebReaderOutput,
  YoutubeArgs,
  YoutubeOutput,
} from "../adapters/adapter.js";

export interface RouteResult<T> {
  readonly output: T;
  readonly provider: string;
  readonly attemptedProviders: string[];
}

export class ResearchRouter {
  private readonly _web: ResearchAdapter[] = [];
  private readonly _search: ResearchAdapter[] = [];
  private readonly _github: ResearchAdapter[] = [];
  private readonly _youtube: ResearchAdapter[] = [];
  private readonly _rss: ResearchAdapter[] = [];

  register(adapter: ResearchAdapter): void {
    switch (adapter.channel) {
      case "web":
        this._web.push(adapter);
        break;
      case "search":
        this._search.push(adapter);
        break;
      case "github":
        this._github.push(adapter);
        break;
      case "youtube":
        this._youtube.push(adapter);
        break;
      case "rss":
        this._rss.push(adapter);
        break;
    }
  }

  adaptersFor(channel: ResearchChannel): readonly ResearchAdapter[] {
    switch (channel) {
      case "web":
        return this._web;
      case "search":
        return this._search;
      case "github":
        return this._github;
      case "youtube":
        return this._youtube;
      case "rss":
        return this._rss;
    }
  }

  private _chain(channel: ResearchChannel): ResearchAdapter[] {
    return [...this.adaptersFor(channel)];
  }

  async routeWeb(
    url: string,
    ctx: AdapterContext,
  ): Promise<RouteResult<{ document: ResearchDocument }>> {
    const attempted: string[] = [];
    for (const adapter of this._chain("web")) {
      if (!adapter.readWeb) {
        continue;
      }
      attempted.push(adapter.provider);
      try {
        const output: WebReaderOutput = await adapter.readWeb(url, ctx);
        return {
          output: { document: output.document },
          provider: adapter.provider,
          attemptedProviders: attempted,
        };
      } catch (err) {
        if (ctx.signal?.aborted) {
          throw err;
        }
        continue;
      }
    }
    throw new ResearchProviderFailed(
      attempted[attempted.length - 1],
      `All web providers failed${attempted.length ? `: ${attempted.join(", ")}` : ""}`,
    );
  }

  async routeSearch(
    query: string,
    limit: number,
    ctx: AdapterContext,
  ): Promise<RouteResult<SearchOutput>> {
    const attempted: string[] = [];
    for (const adapter of this._chain("search")) {
      if (!adapter.search) {
        continue;
      }
      attempted.push(adapter.provider);
      try {
        const output = await adapter.search(query, limit, ctx);
        return { output, provider: adapter.provider, attemptedProviders: attempted };
      } catch (err) {
        if (ctx.signal?.aborted) {
          throw err;
        }
        continue;
      }
    }
    throw new ResearchProviderFailed(
      attempted[attempted.length - 1],
      `All search providers failed${attempted.length ? `: ${attempted.join(", ")}` : ""}`,
    );
  }

  async routeGithub(args: GithubArgs, ctx: AdapterContext): Promise<RouteResult<GithubOutput>> {
    const attempted: string[] = [];
    for (const adapter of this._chain("github")) {
      if (!adapter.readGithub) {
        continue;
      }
      attempted.push(adapter.provider);
      try {
        const output = await adapter.readGithub(args, ctx);
        return { output, provider: adapter.provider, attemptedProviders: attempted };
      } catch (err) {
        if (ctx.signal?.aborted) {
          throw err;
        }
        continue;
      }
    }
    throw new ResearchProviderFailed(
      attempted[attempted.length - 1],
      `All GitHub providers failed${attempted.length ? `: ${attempted.join(", ")}` : ""}`,
    );
  }

  async routeYoutube(args: YoutubeArgs, ctx: AdapterContext): Promise<RouteResult<YoutubeOutput>> {
    const attempted: string[] = [];
    for (const adapter of this._chain("youtube")) {
      if (!adapter.readYoutube) {
        continue;
      }
      attempted.push(adapter.provider);
      try {
        const output = await adapter.readYoutube(args, ctx);
        return { output, provider: adapter.provider, attemptedProviders: attempted };
      } catch (err) {
        if (ctx.signal?.aborted) {
          throw err;
        }
        continue;
      }
    }
    throw new ResearchProviderFailed(
      attempted[attempted.length - 1],
      `All YouTube providers failed${attempted.length ? `: ${attempted.join(", ")}` : ""}`,
    );
  }

  async routeRss(
    feedUrl: string,
    limit: number,
    ctx: AdapterContext,
  ): Promise<RouteResult<RssOutput>> {
    const attempted: string[] = [];
    for (const adapter of this._chain("rss")) {
      if (!adapter.readRss) {
        continue;
      }
      attempted.push(adapter.provider);
      try {
        const output = await adapter.readRss(feedUrl, limit, ctx);
        return { output, provider: adapter.provider, attemptedProviders: attempted };
      } catch (err) {
        if (ctx.signal?.aborted) {
          throw err;
        }
        continue;
      }
    }
    throw new ResearchProviderFailed(
      attempted[attempted.length - 1],
      `All RSS providers failed${attempted.length ? `: ${attempted.join(", ")}` : ""}`,
    );
  }
}
