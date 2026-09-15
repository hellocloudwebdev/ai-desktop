// PR35: apps/desktop — Bounded Secure HTTP Fetch
//
// Single choke point for all outbound research HTTP:
//   1. Pre-request SSRF validation (syntax + DNS + internal-range rejection).
//   2. Manual redirect handling with per-hop re-validation (DNS rebinding
//      protection) and a hard redirect ceiling.
//   3. Bounded response buffering: compressed cap, streaming decompression
//      cap, content-type policy, overall timeout, AbortSignal cancellation.
//   4. Model-safe errors: no credentials, cookies, or internal hostnames.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { isSupportedResearchMimeType, MAX_REDIRECTS } from "@ai-desktop/ai-core";
import {
  ResearchCancelled,
  ResearchResponseTooLarge,
  ResearchTimeout,
  ResearchUnsupportedContent,
  toCanonicalResearchError,
} from "../research-errors.js";
import type { ResearchPolicy } from "../research-policy.js";
import { DEFAULT_RESEARCH_POLICY } from "../research-policy.js";
import {
  assertHostAllowed,
  assertUrlSyntaxAllowed,
  defaultDnsResolver,
  type DnsResolver,
  type SsrfAllowlist,
  validateRedirect,
} from "./ssrf-guard.js";

export interface FetchedResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly contentType: string;
  readonly body: Buffer;
  readonly redirectCount: number;
}

export interface SecureFetchOptions {
  readonly policy?: ResearchPolicy;
  readonly resolver?: DnsResolver;
  readonly allowlist?: SsrfAllowlist;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
  readonly maxRedirects?: number;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizeHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.join(", ");
    }
  }
  return out;
}

function baseMimeType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

interface RawFetch {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function rawRequest(
  url: URL,
  options: {
    headers: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
  },
): Promise<RawFetch> {
  return new Promise<RawFetch>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ResearchCancelled());
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": "ai-desktop-research/1.0",
          "accept-encoding": "gzip, deflate",
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          req.destroy();
          reject(err);
        };
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) {
            fail(new ResearchResponseTooLarge());
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: normalizeHeaders(res.headers),
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", fail);
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new ResearchTimeout());
    }, options.timeoutMs);
    timer.unref?.();
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(toCanonicalResearchError(err));
    });
    req.on("close", () => {
      clearTimeout(timer);
    });
    const onAbort = () => {
      req.destroy(new ResearchCancelled());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => {
      options.signal?.removeEventListener("abort", onAbort);
    });
    req.end();
  });
}

function decompressBounded(body: Buffer, encoding: string, maxBytes: number): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (enc === "" || enc === "identity") {
    if (body.length > maxBytes) {
      throw new ResearchResponseTooLarge();
    }
    return body;
  }
  let inflated: Buffer;
  try {
    if (enc === "gzip") {
      inflated = zlib.gunzipSync(body);
    } else if (enc === "deflate") {
      inflated = zlib.inflateSync(body);
    } else if (enc === "br") {
      inflated = zlib.brotliDecompressSync(body);
    } else {
      // Unknown transfer encoding: treat as opaque and bound raw size.
      if (body.length > maxBytes) {
        throw new ResearchResponseTooLarge();
      }
      return body;
    }
  } catch (err) {
    if (err instanceof ResearchResponseTooLarge) {
      throw err;
    }
    // Malformed compression envelope: fall back to the raw bounded bytes
    // so a corrupt gzip frame cannot fail the whole read.
    if (body.length > maxBytes) {
      throw new ResearchResponseTooLarge();
    }
    return body;
  }
  if (inflated.length > maxBytes) {
    throw new ResearchResponseTooLarge();
  }
  return inflated;
}

/**
 * Secure bounded GET with manual redirect handling. Every hop is SSRF
 * re-validated after resolution. Content types outside the allowlist throw
 * ResearchUnsupportedContent; oversized payloads throw
 * ResearchResponseTooLarge; expired deadlines throw ResearchTimeout;
 * aborted signals throw ResearchCancelled.
 */
export async function secureFetch(
  rawUrl: string,
  options: SecureFetchOptions = {},
): Promise<FetchedResponse> {
  const policy = options.policy ?? DEFAULT_RESEARCH_POLICY;
  const resolver = options.resolver ?? defaultDnsResolver;
  const allowlist = options.allowlist;
  const maxRedirects = options.maxRedirects ?? policy.maxRedirects ?? MAX_REDIRECTS;
  const signal = options.signal;
  if (signal?.aborted) {
    throw new ResearchCancelled();
  }

  // Hop 0: syntax + SSRF validation.
  const first = assertUrlSyntaxAllowed(rawUrl);
  await assertHostAllowed(first.hostname, resolver, allowlist);

  let current = first.toString();
  let redirectCount = 0;
  const deadline = Date.now() + policy.timeouts.overallTimeoutMs;

  for (;;) {
    if (signal?.aborted) {
      throw new ResearchCancelled();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ResearchTimeout("Research operation timed out");
    }
    const url = new URL(current);
    const raw = await rawRequest(url, {
      headers: { ...(options.headers ?? {}) },
      timeoutMs: Math.min(policy.timeouts.bodyTimeoutMs, remaining),
      maxBytes: policy.maxResponseBytes,
      ...(signal ? { signal } : {}),
    });

    if (isRedirect(raw.status)) {
      const location = raw.headers["location"];
      if (!location) {
        throw new ResearchUnsupportedContent(undefined, `Redirect without location`);
      }
      const next = await validateRedirect(
        current,
        location,
        redirectCount,
        maxRedirects,
        resolver,
        allowlist,
      );
      current = next.toString();
      redirectCount += 1;
      continue;
    }

    if (raw.status === 304) {
      throw new ResearchUnsupportedContent(undefined, "Empty response");
    }
    if (raw.status < 200 || raw.status >= 300) {
      throw toCanonicalResearchError(
        new Error(`Request failed with status ${raw.status}`),
        "web-reader",
      );
    }

    const contentType = raw.headers["content-type"] ?? "application/octet-stream";
    const mime = baseMimeType(contentType);
    if (!isSupportedResearchMimeType(mime)) {
      throw new ResearchUnsupportedContent(mime || contentType);
    }
    const body = decompressBounded(
      raw.body,
      raw.headers["content-encoding"] ?? "",
      policy.maxDecompressedBytes,
    );
    return {
      url: current,
      status: raw.status,
      headers: raw.headers,
      contentType: mime || contentType,
      body,
      redirectCount,
    };
  }
}
