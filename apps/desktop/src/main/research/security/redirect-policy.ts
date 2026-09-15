// PR35.8: apps/desktop — Redirect Policy (per-hop revalidation)
//
// Invariants:
//   1. Redirects are followed manually (fetch redirect: "manual") so every
//      hop passes scheme + SSRF validation. The original URL is never
//      trusted after a redirect.
//   2. A single GET loop performs the hops: each hop URL is validated, then
//      fetched with redirect:"manual"; the next Location is resolved against
//      the current hop and re-validated. No separate HEAD probes (which can
//      diverge from GET behavior and double request volume).
//   3. Relative Location values resolve against the current hop URL.
//      Non-http(s) redirect targets and missing Location headers fail closed.
//   4. maxRedirects derives from the research policy; exceeding it fails
//      closed with ResearchRedirectBlocked. Intermediate 3xx bodies are
//      cancelled to free resources.

import { ResearchRedirectBlocked } from "../research-errors.js";
import type { SsrfGuardOptions } from "./ssrf-guard.js";
import { assertSafeResearchDestination } from "./ssrf-guard.js";

export interface RedirectFetchResult {
  readonly response: Response;
  readonly hops: string[];
  readonly finalUrl: string;
}

export interface RedirectPolicyOptions extends SsrfGuardOptions {
  readonly maxRedirects?: number;
  readonly fetchFn?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * GETs a URL while manually walking redirects: every hop (including the
 * first) is scheme + SSRF validated before connecting, and every Location
 * target is re-validated on the next iteration. Returns the final
 * non-redirect response with the hop trail. The caller owns the body
 * (bounded read + MIME check via response-policy).
 */
export async function fetchWithRedirectPolicy(
  startUrl: string,
  options?: RedirectPolicyOptions,
): Promise<RedirectFetchResult> {
  const maxRedirects = options?.maxRedirects ?? 5;
  const fetchFn = options?.fetchFn ?? fetch;
  const hops: string[] = [];
  let current = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { normalizedUrl } = await assertSafeResearchDestination(current, options);
    current = normalizedUrl;
    hops.push(current);
    const response = await fetchFn(current, {
      method: "GET",
      redirect: "manual",
      signal: options?.signal,
      ...(options?.headers ? { headers: options.headers } : {}),
    });
    if (!REDIRECT_STATUS.has(response.status)) {
      return { response, hops, finalUrl: current };
    }
    if (hop === maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResearchRedirectBlocked(`Research redirect chain exceeded ${maxRedirects} hops`);
    }
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new ResearchRedirectBlocked(`Research redirect hop ${hop + 1} has no Location header`);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ResearchRedirectBlocked(`Research redirect target is not a valid URL`);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new ResearchRedirectBlocked(
        `Research redirect target scheme "${next.protocol}" is not allowed`,
      );
    }
    current = next.toString();
  }
  throw new ResearchRedirectBlocked(`Research redirect chain exceeded ${maxRedirects} hops`);
}
