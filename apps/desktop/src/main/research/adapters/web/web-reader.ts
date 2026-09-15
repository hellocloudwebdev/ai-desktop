// PR35.13-35.14: apps/desktop — Engine-Neutral Web Reader + Adapters
//
// Invariants:
//   1. WebPageReader is the interface; StaticWebReader is the primary. A
//      JinaReaderAdapter may sit behind the same boundary but Jina is never
//      the domain abstraction.
//   2. Every read flows url-policy -> per-hop SSRF -> MIME gate -> bounded
//      body -> conservative HTML/text extraction -> bounded document.
//      Redirects re-validate every hop via fetchWithRedirectPolicy.
//   3. Secrets may be needed for future reader backends; this module takes
//      an optional SecretRef resolver and never logs or echoes credentials.
//   4. Raw HTML is never exposed to the model: output is structured
//      title/description/text with provenance.

import {
  canonicalizeResearchUrl,
  createResearchDocumentId,
  createResearchRequestId,
  MAX_REDIRECTS,
  type ResearchDocument,
  type ResearchRequestId,
} from "@ai-desktop/ai-core";
import { ResearchProviderError, toCanonicalResearchError } from "../../research-errors.js";
import { checkResearchUrl } from "../../security/url-policy.js";
import { fetchWithRedirectPolicy } from "../../security/redirect-policy.js";
import { readBoundedBody } from "../../security/response-policy.js";
import type { ResearchPolicy } from "../../research-policy.js";
import {
  createLinkedAbortController,
  defaultResearchPolicy,
  throwIfResearchAborted,
  withResearchTimeout,
} from "../../research-policy.js";

export interface WebReadOptions {
  readonly requestId?: ResearchRequestId;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface WebPageReader {
  readonly provider: string;
  read(url: string, options?: WebReadOptions): Promise<ResearchDocument>;
  health(): Promise<"available" | "authRequired" | "unavailable">;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/gi, " ");
}

function extractTagContent(html: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return match?.[1]?.trim() || undefined;
}

function extractMetaContent(html: string, attr: string, value: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]*${attr}=["']${value}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${value}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

/**
 * Conservative main-content extraction without a parser dependency:
 * strips scripts/styles/nav/footer, prefers <main>/<article>, falls back to
 * body text. All output is whitespace-normalized and bounded.
 */
export function extractReadableText(html: string): {
  title: string;
  description?: string;
  text: string;
} {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav\s*>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer\s*>/gi, " ")
    .replace(/<header[\s\S]*?<\/header\s*>/gi, " ");
  const titleRaw = extractTagContent(withoutScripts, "title") ?? "";
  const description =
    extractMetaContent(withoutScripts, "name", "description") ??
    extractMetaContent(withoutScripts, "property", "og:description");
  const main =
    extractTagContent(withoutScripts, "main") ?? extractTagContent(withoutScripts, "article");
  const scope = main ?? withoutScripts.replace(/<head[\s\S]*?<\/head\s*>/gi, " ");
  const text = decodeHtmlEntities(
    scope
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  return {
    title: decodeHtmlEntities(titleRaw.replace(/\s+/g, " ").trim()).slice(0, 300),
    ...(description ? { description: decodeHtmlEntities(description).slice(0, 1000) } : {}),
    text,
  };
}

export interface StaticWebReaderDeps {
  readonly policy?: ResearchPolicy;
  readonly fetchFn?: typeof fetch;
  readonly resolveAll?: WebReadOptions["resolveAll"];
}

/** Primary reader: safe fetch with per-hop SSRF + bounded extraction. */
export class StaticWebReader implements WebPageReader {
  readonly provider = "static-reader";
  private readonly _policy: ResearchPolicy;
  private readonly _fetchFn?: typeof fetch;
  private readonly _resolveAll?: WebReadOptions["resolveAll"];

  constructor(deps?: StaticWebReaderDeps) {
    this._policy = deps?.policy ?? defaultResearchPolicy();
    this._fetchFn = deps?.fetchFn;
    this._resolveAll = deps?.resolveAll;
  }

  async health(): Promise<"available" | "authRequired" | "unavailable"> {
    return "available";
  }

  async read(url: string, options?: WebReadOptions): Promise<ResearchDocument> {
    const policy = options?.policy ?? this._policy;
    const gate = checkResearchUrl(url);
    if (!gate.allowed) {
      throw new ResearchProviderError(
        this.provider,
        `Research URL rejected: ${gate.reason ?? "invalid"}`,
      );
    }
    // Abort before starting any network work (no orphaned fetches).
    // Linked controller: timeouts and parent cancellation abort the
    // in-flight HTTP request instead of leaving detached network work.
    // Both checks live inside try/catch so raw AbortErrors canonicalize.
    try {
      throwIfResearchAborted(options?.signal);
      const controller = createLinkedAbortController(options?.signal);
      const requestId = options?.requestId ?? createResearchRequestId();
      const maxChars = Math.min(
        options?.maxChars ?? policy.maxDocumentChars,
        policy.maxDocumentChars,
      );
      const fetchFn = options?.fetchFn ?? this._fetchFn;
      return await withResearchTimeout(
        this._readInner(
          gate.normalized ?? url.trim(),
          requestId,
          maxChars,
          policy,
          controller.signal,
          fetchFn,
        ),
        policy.overallTimeoutMs,
        options?.signal,
        () => controller.abort(),
      );
    } catch (err: unknown) {
      throw toCanonicalResearchError(err);
    }
  }

  private async _readInner(
    url: string,
    requestId: ResearchRequestId,
    maxChars: number,
    policy: ResearchPolicy,
    signal?: AbortSignal,
    fetchFn?: typeof fetch,
  ): Promise<ResearchDocument> {
    const { response, finalUrl } = await fetchWithRedirectPolicy(url, {
      maxRedirects: policy.maxRedirects || MAX_REDIRECTS,
      ...(fetchFn ? { fetchFn } : {}),
      ...(this._resolveAll ? { resolveAll: this._resolveAll } : {}),
      denyLoopback: policy.denyLoopback,
      ...(policy.allowedHosts ? { allowedHosts: [...policy.allowedHosts] } : {}),
      ...(signal ? { signal } : {}),
    });
    const body = await readBoundedBody(response, {
      maxBytes: policy.maxDecompressedBytes,
      maxChars,
      ...(signal ? { signal } : {}),
    });
    const retrievedAt = new Date().toISOString();
    if (body.mimeType === "application/json" || body.mimeType === "text/plain") {
      const text = body.text.slice(0, maxChars);
      return {
        id: createResearchDocumentId(),
        requestId,
        url,
        canonicalUrl: canonicalizeResearchUrl(finalUrl) ?? finalUrl,
        title: "",
        text,
        mimeType: body.mimeType,
        truncated: body.truncated || body.text.length > maxChars,
        retrievedAt,
      };
    }
    const extracted = extractReadableText(body.text);
    const text = extracted.text.slice(0, maxChars);
    return {
      id: createResearchDocumentId(),
      requestId,
      url,
      canonicalUrl: canonicalizeResearchUrl(finalUrl) ?? finalUrl,
      title: extracted.title,
      text,
      ...(extracted.description ? { description: extracted.description } : {}),
      mimeType: body.mimeType,
      truncated: body.truncated || extracted.text.length > maxChars,
      retrievedAt,
    };
  }
}

export interface JinaReaderDeps extends StaticWebReaderDeps {
  readonly endpoint?: string;
  readonly resolveSecret?: (ref: string) => Promise<string | null>;
  readonly apiKeyRef?: string;
}

/**
 * Jina Reader adapter (optional backend behind WebPageReader): proxies the
 * URL through r.jina.ai with the same bounds. Jina is an adapter, never the
 * domain abstraction; the static reader stays primary.
 */
export class JinaReaderAdapter implements WebPageReader {
  readonly provider = "jina";
  private readonly _endpoint: string;
  private readonly _inner: StaticWebReader;
  private readonly _resolveSecret?: (ref: string) => Promise<string | null>;
  private readonly _apiKeyRef?: string;

  constructor(deps?: JinaReaderDeps) {
    this._endpoint = deps?.endpoint ?? "https://localhost:8080";
    this._inner = new StaticWebReader(deps);
    this._resolveSecret = deps?.resolveSecret;
    this._apiKeyRef = deps?.apiKeyRef;
  }

  async health(): Promise<"available" | "authRequired" | "unavailable"> {
    if (this._apiKeyRef && !this._resolveSecret) return "authRequired";
    return "available";
  }

  async read(url: string, options?: WebReadOptions): Promise<ResearchDocument> {
    const gate = checkResearchUrl(url);
    if (!gate.allowed) {
      throw new ResearchProviderError(
        this.provider,
        `Research URL rejected: ${gate.reason ?? "invalid"}`,
      );
    }
    let apiKey: string | null = null;
    if (this._apiKeyRef && this._resolveSecret) {
      apiKey = await this._resolveSecret(this._apiKeyRef);
    }
    const target = `${this._endpoint}/${(gate.normalized ?? url.trim()).replace(/^https?:\/\//, "")}`;
    // Auth-injecting fetch wrapper (used when the inner reader has no
    // injected fetch of its own): the key travels only in the Authorization
    // header of this request, never in outputs or errors.
    const fetchFn: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Accept", "text/plain");
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      const base = this._innerFetchFn ?? fetch;
      return base(input, { ...init, headers });
    };
    const doc = await this._inner.read(target, { ...options, fetchFn });
    return { ...doc, mimeType: "text/plain" };
  }

  private get _innerFetchFn(): typeof fetch | undefined {
    return (this._inner as unknown as { _fetchFn?: typeof fetch })._fetchFn;
  }
}
