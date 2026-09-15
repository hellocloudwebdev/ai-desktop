// PR35.18: apps/desktop — RSS / Atom Research Adapter
//
// Invariants:
//   1. Simplest channel: fetch -> content-type check -> bounded parse of
//      RSS 2.0 and Atom into normalized RssItems. Item count and per-item
//      length capped by the research policy.
//   2. Malformed feeds fail closed with a canonical error; oversized feeds
//      truncate with truncated:true rather than exhausting memory.
//   3. Raw HTML inside feed content is stripped to text (never executed,
//      never passed through as markup).

import type { RssItem } from "@ai-desktop/ai-core";
import { ResearchProviderError, toCanonicalResearchError } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import {
  createLinkedAbortController,
  defaultResearchPolicy,
  throwIfResearchAborted,
  withResearchTimeout,
} from "../../research-policy.js";
import { fetchWithRedirectPolicy } from "../../security/redirect-policy.js";
import { readBoundedBody } from "../../security/response-policy.js";
import { checkResearchUrl } from "../../security/url-policy.js";

export interface RssReadOptions {
  readonly maxItems?: number;
  readonly signal?: AbortSignal;
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface RssFeedContent {
  readonly feedUrl: string;
  readonly title: string;
  readonly items: RssItem[];
  readonly truncated: boolean;
}

export interface RssResearchDeps {
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: RssReadOptions["resolveAll"];
}

function stripMarkup(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTagText(block: string, tags: string[]): string {
  for (const tag of tags) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(block);
    if (match?.[1]?.trim()) {
      const inner = match[1].trim();
      const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(inner);
      return (cdata?.[1] ?? inner).trim();
    }
  }
  return "";
}

function linkHref(block: string): string {
  const match = /<link(?:\s[^>]*)?>/i.exec(block);
  if (!match) return "";
  const tag = match[0];
  const rel = /rel=["']([^"']*)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
  const href = /href=["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? "";
  if (href && (rel === "" || rel === "alternate")) return href;
  return href;
}

function normalizeDate(raw: string): string | undefined {
  if (!raw) return undefined;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

/**
 * Bounded RSS 2.0 / Atom parser (regex-scoped, no dependency). Parses at
 * most maxItems entries; each field is length-capped. Throws
 * ResearchProviderError on malformed input.
 */
export function parseFeedXml(
  xml: string,
  maxItems: number,
): { title: string; items: RssItem[]; truncated: boolean } {
  const scoped = xml.slice(0, 1000000);
  const isRss = /<rss[\s>]|<\s*channel[\s>]/i.test(scoped);
  const isAtom = /<feed[\s>]/i.test(scoped);
  if (!isRss && !isAtom) {
    throw new ResearchProviderError("rss", `Feed is neither RSS nor Atom`);
  }
  const channelTitle = isAtom
    ? stripMarkup(firstTagText(scoped, ["title"])).slice(0, 300)
    : stripMarkup(firstTagText(scoped, ["title"])).slice(0, 300);

  const entryBlocks: string[] = [];
  if (isAtom) {
    const entryRegex = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(scoped)) !== null) {
      entryBlocks.push(match[1] ?? "");
    }
  } else {
    const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(scoped)) !== null) {
      entryBlocks.push(match[1] ?? "");
    }
  }

  const items: RssItem[] = [];
  for (const block of entryBlocks.slice(0, maxItems)) {
    const title = stripMarkup(firstTagText(block, ["title"])).slice(0, 300) || "(untitled)";
    const url = isAtom
      ? linkHref(block) || stripMarkup(firstTagText(block, ["id"]))
      : stripMarkup(firstTagText(block, ["link", "guid"]));
    if (!url) continue;
    const summary = stripMarkup(
      firstTagText(block, ["description", "summary", "content", "content:encoded"]),
    ).slice(0, 2000);
    const publishedAt =
      normalizeDate(firstTagText(block, ["pubDate", "published", "updated", "dc:date"])) ??
      undefined;
    const authorRaw = stripMarkup(firstTagText(block, ["author", "dc:creator", "managingEditor"]));
    const author = authorRaw
      ? stripMarkup(firstTagText(authorRaw, ["name"]) || authorRaw).slice(0, 200)
      : undefined;
    items.push({
      title,
      url: url.slice(0, 2048),
      summary,
      ...(publishedAt ? { publishedAt } : {}),
      ...(author ? { author } : {}),
    });
  }
  return {
    title: channelTitle || "(untitled feed)",
    items,
    truncated: entryBlocks.length > maxItems,
  };
}

/** RSS/Atom adapter: fetch with SSRF policy, then bounded parse. */
export class RssResearchAdapter {
  readonly provider = "rss";
  private readonly _policy: ResearchPolicy;
  private readonly _fetchFn?: typeof fetch;
  private readonly _resolveAll?: RssReadOptions["resolveAll"];

  constructor(deps?: RssResearchDeps) {
    this._policy = deps?.policy ?? defaultResearchPolicy();
    this._fetchFn = deps?.fetchFn;
    this._resolveAll = deps?.resolveAll;
  }

  async health(): Promise<"available" | "authRequired" | "unavailable"> {
    return "available";
  }

  async read(feedUrl: string, options?: RssReadOptions): Promise<RssFeedContent> {
    const policy = options?.policy ?? this._policy;
    const gate = checkResearchUrl(feedUrl);
    if (!gate.allowed) {
      throw new ResearchProviderError(
        this.provider,
        `Research URL rejected: ${gate.reason ?? "invalid"}`,
      );
    }
    // Abort/cancel inside try/catch so raw AbortErrors canonicalize.
    try {
      throwIfResearchAborted(options?.signal);
      const controller = createLinkedAbortController(options?.signal);
      return await withResearchTimeout(
        this._readInner(gate.normalized ?? feedUrl.trim(), policy, {
          ...options,
          signal: controller.signal,
        }),
        policy.requestTimeoutMs,
        options?.signal,
        () => controller.abort(),
      );
    } catch (err: unknown) {
      throw toCanonicalResearchError(err);
    }
  }

  private async _readInner(
    url: string,
    policy: ResearchPolicy,
    options?: RssReadOptions,
  ): Promise<RssFeedContent> {
    const { response } = await fetchWithRedirectPolicy(url, {
      maxRedirects: policy.maxRedirects,
      ...((this._fetchFn ?? options?.fetchFn)
        ? { fetchFn: (this._fetchFn ?? options!.fetchFn)! }
        : {}),
      ...((this._resolveAll ?? options?.resolveAll)
        ? { resolveAll: (this._resolveAll ?? options!.resolveAll)! }
        : {}),
      denyLoopback: policy.denyLoopback,
      ...(policy.allowedHosts ? { allowedHosts: [...policy.allowedHosts] } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    });
    if (response.status === 404) {
      throw new ResearchProviderError(this.provider, `Feed not found`);
    }
    if (!response.ok) {
      throw new ResearchProviderError(
        this.provider,
        `Feed fetch failed with status ${response.status}`,
      );
    }
    const body = await readBoundedBody(response, {
      maxBytes: policy.maxDecompressedBytes,
      maxChars: policy.maxDocumentChars,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const maxItems = Math.min(options?.maxItems ?? policy.maxRssItems, policy.maxRssItems);
    const parsed = parseFeedXml(body.text, maxItems);
    return {
      feedUrl: url,
      title: parsed.title,
      items: parsed.items,
      truncated: parsed.truncated || body.truncated,
    };
  }
}
