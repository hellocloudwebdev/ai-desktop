// PR36: apps/desktop — Conservative Source URL Canonicalizer
//
// Normalizes research URLs so that trivial variants (tracking params,
// fragments, default ports, case, trailing slash) collapse to one
// canonical source. Conservative by design: distinct paths, hosts, or
// meaningful query params NEVER merge. Invalid input throws ValidationError
// (canonicalize) or returns false / is skipped (sameSourceUrl / grouping).

import { ValidationError } from "@ai-desktop/shared";

const TRACKING_PARAMS = new Set([
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "igshid",
  "yclid",
  "twclid",
  "_ga",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || lower.startsWith("mc_") || TRACKING_PARAMS.has(lower);
}

export function canonicalizeSourceUrl(rawUrl: string): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new ValidationError("Source URL must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ValidationError(`Invalid source URL: "${rawUrl.slice(0, 200)}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(`Unsupported source URL scheme: "${parsed.protocol}"`);
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  const kept: Array<[string, string]> = [];
  parsed.searchParams.forEach((value, key) => {
    if (!isTrackingParam(key)) {
      kept.push([key, value]);
    }
  });
  kept.sort(([aKey, aVal], [bKey, bVal]) =>
    aKey < bKey ? -1 : aKey > bKey ? 1 : aVal < bVal ? -1 : aVal > bVal ? 1 : 0,
  );
  parsed.search = "";
  for (const [key, value] of kept) {
    parsed.searchParams.append(key, value);
  }
  let canonical = parsed.toString();
  if (parsed.pathname !== "/" && canonical.endsWith("/")) {
    canonical = canonical.slice(0, -1);
  }
  if (parsed.pathname === "/" && !parsed.search && canonical.endsWith("/")) {
    canonical = canonical.slice(0, -1);
  }
  return canonical;
}

/** Compare two URLs by canonical form. Never throws — false on invalid input. */
export function sameSourceUrl(a: string, b: string): boolean {
  try {
    return canonicalizeSourceUrl(a) === canonicalizeSourceUrl(b);
  } catch {
    return false;
  }
}

export interface SourceGroupInput {
  readonly url: string;
  readonly title?: string;
  readonly provider: string;
}

export interface SourceGroup {
  readonly canonicalUrl: string;
  readonly rawUrls: string[];
  readonly title?: string;
  readonly providers: string[];
}

/**
 * Group search hits by canonical URL (cross-provider dedup input).
 * First-seen title wins; providers unioned; invalid URLs skipped.
 */
export function groupSourcesByCanonicalUrl(items: readonly SourceGroupInput[]): SourceGroup[] {
  const groups = new Map<string, { rawUrls: string[]; title?: string; providers: string[] }>();
  for (const item of items) {
    let canonical: string;
    try {
      canonical = canonicalizeSourceUrl(item.url);
    } catch {
      continue;
    }
    const existing = groups.get(canonical);
    if (!existing) {
      groups.set(canonical, {
        rawUrls: [item.url],
        ...(item.title ? { title: item.title } : {}),
        providers: [item.provider],
      });
      continue;
    }
    if (!existing.rawUrls.includes(item.url)) {
      existing.rawUrls.push(item.url);
    }
    if (!existing.providers.includes(item.provider)) {
      existing.providers.push(item.provider);
    }
  }
  return [...groups.entries()].map(([canonicalUrl, group]) => ({
    canonicalUrl,
    rawUrls: group.rawUrls,
    ...(group.title ? { title: group.title } : {}),
    providers: group.providers,
  }));
}
