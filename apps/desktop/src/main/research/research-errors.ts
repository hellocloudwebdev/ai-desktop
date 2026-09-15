// PR35.6-35.9: apps/desktop — Canonical Research Errors
//
// Invariants:
//   1. Canonical research domain errors derive from BaseError (shared) with
//      explicit error codes. Zero vendor SDK or Electron types leak.
//   2. toCanonicalResearchError maps unknown/external errors into canonical
//      instances; abortions and timeouts classify deterministically.
//   3. Error messages never carry secrets: API keys, tokens, cookies, and
//      authorization headers are redacted before the message is built.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

const SECRET_VALUE_PATTERN =
  /(sk-ant-[a-zA-Z0-9_-]{20,}|AIzaSy[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9._~+/-]{8,}|xox[bap]-[a-zA-Z0-9-]+|gh[pousr]_[a-zA-Z0-9]{20,}|-----BEGIN\s+[A-Z\s]+PRIVATE\s+KEY-----)/g;

/** Redacts raw credential values from text destined for errors or logs. */
export function redactResearchSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  return text
    .replace(SECRET_VALUE_PATTERN, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|access_token)[^=]*=)[^&\s]+/gi, "$1[REDACTED]");
}

export class ResearchError extends BaseError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, redactResearchSecrets(message), options);
    this.name = "ResearchError";
  }
}

export class ResearchUrlRejected extends ResearchError {
  constructor(message = "Research URL rejected by policy", options?: ErrorOptions) {
    super("URL_REJECTED", message, options);
    this.name = "ResearchUrlRejected";
  }
}

export class ResearchSsrfBlocked extends ResearchError {
  constructor(message = "Research destination blocked by SSRF guard", options?: ErrorOptions) {
    super("SSRF_BLOCKED", message, options);
    this.name = "ResearchSsrfBlocked";
  }
}

export class ResearchRedirectBlocked extends ResearchError {
  constructor(message = "Research redirect blocked by policy", options?: ErrorOptions) {
    super("REDIRECT_BLOCKED", message, options);
    this.name = "ResearchRedirectBlocked";
  }
}

export class ResearchUnsupportedMime extends ResearchError {
  readonly mimeType?: string;

  constructor(mimeType?: string, message?: string, options?: ErrorOptions) {
    super(
      "UNSUPPORTED_MIME",
      message ??
        (mimeType ? `Unsupported response type "${mimeType}"` : "Unsupported response type"),
      options,
    );
    this.name = "ResearchUnsupportedMime";
    this.mimeType = mimeType;
  }
}

export class ResearchResponseTooLarge extends ResearchError {
  constructor(message = "Research response exceeded size limits", options?: ErrorOptions) {
    super("RESPONSE_TOO_LARGE", message, options);
    this.name = "ResearchResponseTooLarge";
  }
}

export class ResearchProviderError extends ResearchError {
  readonly provider?: string;

  constructor(provider?: string, message?: string, options?: ErrorOptions) {
    super(
      "PROVIDER_ERROR",
      message ?? (provider ? `Research provider "${provider}" failed` : "Research provider failed"),
      options,
    );
    this.name = "ResearchProviderError";
    this.provider = provider;
  }
}

export class ResearchAuthRequired extends ResearchError {
  readonly provider?: string;

  constructor(provider?: string, message?: string, options?: ErrorOptions) {
    super(
      "AUTH_REQUIRED",
      message ??
        (provider
          ? `Research provider "${provider}" requires credentials (SecretRef)`
          : "Research provider requires credentials (SecretRef)"),
      options,
    );
    this.name = "ResearchAuthRequired";
    this.provider = provider;
  }
}

export class ResearchTimeout extends ResearchError {
  constructor(message = "Research operation timed out", options?: ErrorOptions) {
    super("TIMEOUT", message, options);
    this.name = "ResearchTimeout";
  }
}

export class ResearchCancelled extends ResearchError {
  constructor(message = "Research operation cancelled", options?: ErrorOptions) {
    super("CANCELLED", message, options);
    this.name = "ResearchCancelled";
  }
}

export class ResearchNotFound extends ResearchError {
  constructor(message = "Research resource not found", options?: ErrorOptions) {
    super("NOT_FOUND", message, options);
    this.name = "ResearchNotFound";
  }
}

export class ResearchUnavailable extends ResearchError {
  constructor(message = "Research content unavailable", options?: ErrorOptions) {
    super("UNAVAILABLE", message, options);
    this.name = "ResearchUnavailable";
  }
}

/** Maps any unknown error to a canonical ResearchError (secrets redacted). */
export function toCanonicalResearchError(err: unknown): ResearchError {
  if (err instanceof ResearchError) {
    return err;
  }
  const message = redactResearchSecrets(err instanceof Error ? err.message : String(err));
  const name = err instanceof Error ? err.name : "";
  if (
    name === "AbortError" ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
    /\b(aborted|cancelled|canceled)\b/i.test(message)
  ) {
    return new ResearchCancelled(message || "Research operation cancelled", { cause: err });
  }
  if (name === "TimeoutError" || /\b(timed?\s*out|timeout)\b/i.test(message)) {
    return new ResearchTimeout(message || "Research operation timed out", { cause: err });
  }
  if (
    /\b(ssrf|private (address|ip)|loopback|link-local|metadata (service|endpoint)|forbidden host)\b/i.test(
      message,
    )
  ) {
    return new ResearchSsrfBlocked(message, { cause: err });
  }
  if (/\b(redirect failed|too many redirects|redirect blocked|redirect loop)\b/i.test(message)) {
    return new ResearchRedirectBlocked(message, { cause: err });
  }
  if (/\b(unsupported (media|content|mime)|content type .* not supported)\b/i.test(message)) {
    return new ResearchUnsupportedMime(undefined, message, { cause: err });
  }
  if (
    /\b(unauthorized|unauthenticated|bad credentials|invalid api key|auth required|401)\b/i.test(
      message,
    )
  ) {
    return new ResearchAuthRequired(undefined, message, { cause: err });
  }
  if (/\b(not found|404)\b/i.test(message)) {
    return new ResearchNotFound(message, { cause: err });
  }
  if (/\b(response|body|document|payload) (too large|exceeded|exceeds)\b/i.test(message)) {
    return new ResearchResponseTooLarge(message, { cause: err });
  }
  return new ResearchProviderError(undefined, message || "Research provider failed", {
    cause: err,
  });
}
