// PR35.6: apps/desktop — Research URL Policy (syntactic gate)
//
// Invariants:
//   1. Syntactic checks only: scheme allowlist (http/https), host presence,
//      length caps. IP-range enforcement needs DNS and lives in ssrf-guard.
//   2. Never throws on garbage: returns a typed rejection reason instead.
//   3. No network access from this module.

import { DANGEROUS_RESEARCH_URL_PATTERN } from "@ai-desktop/ai-core";

export type UrlRejectionReason =
  "empty" | "too-long" | "dangerous-scheme" | "unsupported-scheme" | "unparseable" | "missing-host";

export interface UrlPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: UrlRejectionReason;
  readonly normalized?: string;
}

const MAX_URL_LENGTH = 2048;

/** Syntactic URL gate shared by every adapter before DNS/SSRF checks. */
export function checkResearchUrl(raw: unknown): UrlPolicyDecision {
  if (typeof raw !== "string") {
    return { allowed: false, reason: "empty" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: "empty" };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { allowed: false, reason: "too-long" };
  }
  if (DANGEROUS_RESEARCH_URL_PATTERN.test(trimmed)) {
    return { allowed: false, reason: "dangerous-scheme" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { allowed: false, reason: "unparseable" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "unsupported-scheme" };
  }
  if (!parsed.hostname) {
    return { allowed: false, reason: "missing-host" };
  }
  return { allowed: true, normalized: parsed.toString() };
}
