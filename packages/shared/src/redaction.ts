// PR46: packages/shared — Centralized Secret Redaction
//
// Domain-neutral secret scrubbing for error messages, logs, and any
// human-readable surface that must never echo credential material.
//
// Scope:
//   - API keys, bearer tokens, OAuth/access/refresh tokens, passwords,
//     cookies, authorization headers, private-key blocks, and well-known
//     provider token shapes (GitHub, Slack, AWS, JWT, sk-*).
//   - Prose passthrough: bare words without a credential assignment
//     (e.g. "token limit", "password policy") are left untouched. Only
//     `key[:=]value`, `Bearer <value>`, header lines, and standalone
//     token shapes are redacted.
//
// Conceptual use (no cross-package wiring — sibling error sanitizers in
// apps/desktop mirror this semantics locally to preserve layering):
//   - Sibling `redactSecretsFromMessage` implementations are narrow subsets
//     of this taxonomy; this module is the canonical reference.

export const REDACTED = "[REDACTED]";

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const STANDALONE_TOKEN_PATTERNS: RegExp[] = [
  /\bsk-(live|test|ant)-[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bAIzaSy[A-Za-z0-9_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/g,
  /\bxox[bap]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const ASSIGNMENT_PATTERNS: RegExp[] = [
  /api[_-]?key\s*[:=]\s*['"]?[^\s'";,]+/gi,
  /\bx-api-key\s*:\s*['"]?[^\s'";,]+/gi,
  /\b(oauth|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret)\s*[:=]\s*['"]?[^\s'";,]+/gi,
  /\b(passw(or)?d|passwd)\s*[:=]\s*['"]?[^\s'";,]+/gi,
];

const HEADER_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
  /\bcookie\s*:\s*[^\r\n;]+/gi,
  /\bauthorization\s*:\s*[^\r\n]+/gi,
  /\bset-cookie\s*:\s*[^\r\n]+/gi,
];

function resetAll(patterns: RegExp[]): void {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
  }
}

/**
 * Redacts secret material from free text. Idempotent: running twice yields
 * the same output. Bare prose without a credential assignment is preserved.
 */
export function redactSecrets(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    return input;
  }
  resetAll([
    PRIVATE_KEY_BLOCK_PATTERN,
    ...STANDALONE_TOKEN_PATTERNS,
    ...ASSIGNMENT_PATTERNS,
    ...HEADER_PATTERNS,
  ]);
  let out = input.replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED);
  for (const pattern of STANDALONE_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  for (const pattern of ASSIGNMENT_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  for (const pattern of HEADER_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Returns true when the text appears to carry secret material. Used by
 * tests and by callers that must refuse (rather than scrub) persistence.
 * Mirrors `redactSecrets` detection without allocating a redacted copy.
 */
export function containsSecretMaterial(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) {
    return false;
  }
  resetAll([
    PRIVATE_KEY_BLOCK_PATTERN,
    ...STANDALONE_TOKEN_PATTERNS,
    ...ASSIGNMENT_PATTERNS,
    ...HEADER_PATTERNS,
  ]);
  if (PRIVATE_KEY_BLOCK_PATTERN.test(input)) {
    return true;
  }
  for (const pattern of [
    ...STANDALONE_TOKEN_PATTERNS,
    ...ASSIGNMENT_PATTERNS,
    ...HEADER_PATTERNS,
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(input)) {
      return true;
    }
  }
  return false;
}
