// PR35: apps/desktop — Static Web Reader Adapter
//
// Engine-neutral WebPageReader: secureFetch -> content-type check -> HTML
// extraction (title, main text, metadata) -> bounded ResearchDocument.
// Dependency-free extraction: strips scripts/styles/nav, decodes entities,
// collapses whitespace. Empty output signals "needs browser fallback".

import {
  canonicalizeResearchUrl,
  createResearchDocumentId,
  MAX_RESEARCH_DOCUMENT_CHARS,
  type ResearchChannel,
  type ResearchDocument,
} from "@ai-desktop/ai-core";
import { createTimestamp } from "@ai-desktop/shared";
import { ResearchCancelled } from "../../research-errors.js";
import type { ResearchPolicy } from "../../research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "../../research-policy.js";
import { secureFetch } from "../../security/secure-fetch.js";
import type { DnsResolver } from "../../security/ssrf-guard.js";
import type { AdapterContext, ResearchAdapter, WebReaderOutput } from "../adapter.js";

export const WEB_READER_PROVIDER = "static-reader";

export interface WebReaderDeps {
  readonly policy?: ResearchPolicy;
  readonly resolver?: DnsResolver;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&apos;/gi, "'");
}

function stripIgnoredSections(html: string): string {
  return html
    .replace(/<script[\s>][\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s>][\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s>][\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

export function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,500})["']/i);
  if (og?.[1]) {
    return decodeEntities(og[1].trim()).slice(0, 500);
  }
  const title = html.match(/<title[^>]*>([\s\S]{1,2000})<\/title\s*>/i);
  if (title?.[1]) {
    return decodeEntities(title[1].replace(/\s+/g, " ").trim()).slice(0, 500);
  }
  const h1 = html.match(/<h1[^>]*>([\s\S]{1,500})<\/h1\s*>/i);
  if (h1?.[1]) {
    return decodeEntities(
      h1[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ).slice(0, 500);
  }
  return "";
}

export function extractMainText(html: string): string {
  const cleaned = stripIgnoredSections(html);
  // Prefer <main>, else <article>, else body content.
  const main = cleaned.match(/<main[\s>][\s\S]*?<\/main\s*>/i);
  const article = !main ? cleaned.match(/<article[\s>][\s\S]*?<\/article\s*>/i) : null;
  const scope = main?.[0] ?? article?.[0] ?? cleaned;
  const withBreaks = scope
    .replace(/<(br|p|div|h[1-6]|li|tr|section|header|footer|blockquote)[\s>]/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|header|footer|blockquote)>/gi, "\n");
  const noTags = withBreaks.replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags)
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function extractMetaDescription(html: string): string {
  const meta =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,1000})["']/i) ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,1000})["']/i);
  return meta?.[1] ? decodeEntities(meta[1].trim()).slice(0, 1000) : "";
}

export class StaticWebReaderAdapter implements ResearchAdapter {
  readonly provider = WEB_READER_PROVIDER;
  readonly channel: ResearchChannel = "web";
  private readonly _policy: ResearchPolicy;
  private readonly _resolver?: DnsResolver;

  constructor(deps: WebReaderDeps = {}) {
    this._policy = deps.policy ?? DEFAULT_RESEARCH_POLICY;
    this._resolver = deps.resolver;
  }

  async readWeb(url: string, ctx: AdapterContext): Promise<WebReaderOutput> {
    if (ctx.signal?.aborted) {
      throw new ResearchCancelled();
    }
    const fetched = await secureFetch(url, {
      policy: this._policy,
      ...(this._resolver ? { resolver: this._resolver } : {}),
      ...(this._policy.allowedHosts
        ? { allowlist: { allowedHosts: this._policy.allowedHosts } }
        : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const raw = fetched.body.toString("utf-8");
    const maxChars = this._policy.maxDocumentChars || MAX_RESEARCH_DOCUMENT_CHARS;
    let text: string;
    let title: string;
    if (fetched.contentType === "text/html") {
      title = extractTitle(raw);
      text = extractMainText(raw);
      if (!text) {
        const desc = extractMetaDescription(raw);
        text = desc;
      }
    } else {
      // text/plain, JSON, XML/RSS payloads: use verbatim bounded text.
      title = "";
      text = raw;
    }
    const truncated = text.length > maxChars;
    const bounded = truncated ? text.slice(0, maxChars) : text;
    let canonicalUrl: string | undefined;
    try {
      canonicalUrl = canonicalizeResearchUrl(fetched.url);
    } catch {
      canonicalUrl = undefined;
    }
    const retrievedAt = createTimestamp();
    const document: ResearchDocument = {
      id: createResearchDocumentId(),
      requestId: ctx.requestId as ResearchDocument["requestId"],
      url: fetched.url,
      ...(canonicalUrl ? { canonicalUrl } : {}),
      title,
      text: bounded,
      mimeType: fetched.contentType,
      truncated,
      retrievedAt,
      provider: WEB_READER_PROVIDER,
      attemptedProviders: [WEB_READER_PROVIDER],
    };
    return { document };
  }
}
