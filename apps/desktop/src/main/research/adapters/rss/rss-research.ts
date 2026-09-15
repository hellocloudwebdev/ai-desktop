// PR35: apps/desktop — RSS/Atom Research Adapter
//
// Dependency-free feed parsing: secureFetch -> XML item/entry extraction ->
// bounded normalized items (title, url, summary, publishedAt, author).
// Handles RSS 2.0 and Atom; malformed feeds fail with a model-safe error.

import type { ResearchChannel } from "@ai-desktop/ai-core";
import { MAX_RSS_ITEMS } from "@ai-desktop/ai-core";
import { ResearchCancelled, ResearchProviderFailed } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "../../research-policy.js";
import { secureFetch } from "../../security/secure-fetch.js";
import type { DnsResolver } from "../../security/ssrf-guard.js";
import type { AdapterContext, ResearchAdapter, RssOutput, RssResearchItem } from "../adapter.js";

export const RSS_ADAPTER_PROVIDER = "rss";

export interface RssAdapterDeps {
  readonly policy?: ResearchPolicy;
  readonly resolver?: DnsResolver;
}

function boundLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    return 20;
  }
  return Math.min(Math.floor(limit), MAX_RSS_ITEMS);
}

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'");
}

function stripTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, "i"));
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return "";
}

function linkHref(block: string): string {
  // Atom <link href="..."/> (rel alternate preferred).
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  for (const tag of links) {
    const rel = /rel=["']([^"']*)["']/i.exec(tag)?.[1] ?? "alternate";
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href && (rel === "alternate" || rel === "")) {
      return href.trim();
    }
  }
  const first = links.length > 0 ? /href=["']([^"']+)["']/i.exec(links[0] ?? "")?.[1] : undefined;
  return first?.trim() ?? "";
}

function normalizeDate(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const time = Date.parse(raw.trim());
  if (!Number.isFinite(time)) {
    return undefined;
  }
  return new Date(time).toISOString();
}

function parseRssItems(
  xml: string,
  limit: number,
): { items: RssResearchItem[]; feedTitle?: string } {
  const channelBlock = /<channel[\s>][\s\S]*?<\/channel\s*>/i.exec(xml)?.[0] ?? "";
  const feedTitleRaw = firstTag(channelBlock || xml, ["title"]);
  const feedTitle = feedTitleRaw ? stripTags(feedTitleRaw).slice(0, 300) : undefined;

  const itemBlocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item\s*>/gi)].map((m) => m[0]);
  const entryBlocks =
    itemBlocks.length > 0
      ? []
      : [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry\s*>/gi)].map((m) => m[0]);
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;
  if (blocks.length === 0) {
    throw new ResearchProviderFailed(RSS_ADAPTER_PROVIDER, "Feed contains no items");
  }
  const items: RssResearchItem[] = [];
  for (const block of blocks.slice(0, limit)) {
    const title = stripTags(firstTag(block, ["title"])).slice(0, 300) || "(untitled)";
    const link = firstTag(block, ["link"]);
    const url = (linkHref(block) || stripTags(link)).slice(0, 2048);
    if (!url) {
      continue;
    }
    const summary = stripTags(
      firstTag(block, ["description", "summary", "content", "content:encoded"]),
    ).slice(0, 1000);
    const publishedAt = normalizeDate(
      firstTag(block, ["pubDate", "published", "updated", "dc:date"]),
    );
    const authorRaw = firstTag(block, ["author", "dc:creator"]);
    const author = authorRaw ? stripTags(authorRaw).slice(0, 200) : undefined;
    items.push({
      title,
      url,
      summary,
      ...(publishedAt ? { publishedAt } : {}),
      ...(author ? { author } : {}),
    });
  }
  return { items, ...(feedTitle ? { feedTitle } : {}) };
}

export class RssResearchAdapter implements ResearchAdapter {
  readonly provider = RSS_ADAPTER_PROVIDER;
  readonly channel: ResearchChannel = "rss";
  private readonly _policy: ResearchPolicy;
  private readonly _resolver?: DnsResolver;

  constructor(deps: RssAdapterDeps = {}) {
    this._policy = deps.policy ?? DEFAULT_RESEARCH_POLICY;
    this._resolver = deps.resolver;
  }

  async readRss(feedUrl: string, limit: number, ctx: AdapterContext): Promise<RssOutput> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const fetched = await secureFetch(feedUrl, {
      policy: this._policy,
      ...(this._resolver ? { resolver: this._resolver } : {}),
      ...(this._policy.allowedHosts
        ? { allowlist: { allowedHosts: this._policy.allowedHosts } }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const xml = fetched.body.toString("utf-8");
    if (!/<(rss|feed|rdf)[\s>]/i.test(xml)) {
      throw new ResearchProviderFailed(RSS_ADAPTER_PROVIDER, "URL did not return a feed document");
    }
    return parseRssItems(xml, boundLimit(limit));
  }
}
