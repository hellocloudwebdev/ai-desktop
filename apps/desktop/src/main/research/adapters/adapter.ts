// PR35: apps/desktop — Adapter Contracts
//
// Single ResearchAdapter interface every channel adapter implements.
// Adapters are host-controlled: no shells, no package installation, no
// credential leakage. All network access flows through secureFetch.

import type { ResearchChannel, ResearchDocument, ResearchSearchResult } from "@ai-desktop/ai-core";

export interface AdapterContext {
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export interface WebReaderOutput {
  readonly document: ResearchDocument;
}

export interface SearchOutput {
  readonly results: ResearchSearchResult[];
}

export interface GithubOutput {
  readonly results: GithubResearchItem[];
}

export interface GithubResearchItem {
  readonly kind: "repository" | "file" | "issue" | "search";
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly path?: string;
}

export interface YoutubeOutput {
  readonly results: YoutubeResearchItem[];
}

export interface YoutubeResearchItem {
  readonly videoId?: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly channelTitle?: string;
  readonly publishedAt?: string;
  readonly transcript?: string;
}

export interface RssOutput {
  readonly items: RssResearchItem[];
  readonly feedTitle?: string;
}

export interface RssResearchItem {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly publishedAt?: string;
  readonly author?: string;
}

export interface ResearchAdapter {
  readonly provider: string;
  readonly channel: ResearchChannel;
  readWeb?(url: string, ctx: AdapterContext): Promise<WebReaderOutput>;
  search?(query: string, limit: number, ctx: AdapterContext): Promise<SearchOutput>;
  readGithub?(args: GithubArgs, ctx: AdapterContext): Promise<GithubOutput>;
  readYoutube?(args: YoutubeArgs, ctx: AdapterContext): Promise<YoutubeOutput>;
  readRss?(feedUrl: string, limit: number, ctx: AdapterContext): Promise<RssOutput>;
}

export interface GithubArgs {
  readonly query?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly path?: string;
  readonly kind: "repository" | "file" | "issue" | "search";
  readonly limit: number;
}

export interface YoutubeArgs {
  readonly videoId?: string;
  readonly query?: string;
  readonly includeTranscript: boolean;
  readonly limit: number;
}
