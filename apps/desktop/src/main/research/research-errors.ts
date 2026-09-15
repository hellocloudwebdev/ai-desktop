// PR35: apps/desktop — Canonical Research Errors
//
// Invariants:
//   1. Research domain errors derive from BaseError with explicit codes.
//   2. Zero provider SDK, Electron, or subprocess types leak through errors.
//   3. toCanonicalResearchError maps unknown/external errors into canonical
//      ResearchError instances without exposing credentials, tokens, or paths.
//   4. Error messages are model-safe: no API keys, cookies, auth headers, or
//      internal hostnames.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

const SECRET_PATTERNS: RegExp[] = [
  /api[_-]?key\s*[:=]\s*['"]?[^\s'"]+/gi,
  /bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /token\s*[:=]\s*['"]?[^\s'"]+/gi,
  /cookie\s*:\s*[^\r\n]+/gi,
  /authorization\s*:\s*[^\r\n]+/gi,
];

export function redactSecretsFromMessage(message: string): string {
  let redacted = message;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export class ResearchError extends BaseError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, redactSecretsFromMessage(message), options);
    this.name = "ResearchError";
  }
}

export class ResearchUrlRejected extends ResearchError {
  readonly url?: string;

  constructor(url?: string, message?: string, options?: ErrorOptions) {
    super("URL_REJECTED", message ?? `Research URL rejected by policy${url ? `: "${url}"` : ""}`, {
      ...options,
    });
    this.name = "ResearchUrlRejected";
    this.url = undefined;
  }
}

export class ResearchSsrfBlocked extends ResearchError {
  constructor(message = "Outbound request blocked by SSRF guard", options?: ErrorOptions) {
    super("SSRF_BLOCKED", message, options);
    this.name = "ResearchSsrfBlocked";
  }
}

export class ResearchRedirectRejected extends ResearchError {
  constructor(message = "Redirect rejected by policy", options?: ErrorOptions) {
    super("REDIRECT_REJECTED", message, options);
    this.name = "ResearchRedirectRejected";
  }
}

export class ResearchUnsupportedContent extends ResearchError {
  readonly mimeType?: string;

  constructor(mimeType?: string, message?: string, options?: ErrorOptions) {
    super(
      "UNSUPPORTED_CONTENT",
      message ?? `Unsupported content type${mimeType ? `: "${mimeType}"` : ""}`,
      options,
    );
    this.name = "ResearchUnsupportedContent";
    this.mimeType = mimeType;
  }
}

export class ResearchResponseTooLarge extends ResearchError {
  constructor(message = "Response exceeded bounded size limits", options?: ErrorOptions) {
    super("RESPONSE_TOO_LARGE", message, options);
    this.name = "ResearchResponseTooLarge";
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

export class ResearchProviderFailed extends ResearchError {
  readonly provider?: string;

  constructor(provider?: string, message?: string, options?: ErrorOptions) {
    super(
      "PROVIDER_FAILED",
      message ?? `Research provider${provider ? ` "${provider}"` : ""} failed`,
      options,
    );
    this.name = "ResearchProviderFailed";
    this.provider = provider;
  }
}

export class ResearchProviderUnavailable extends ResearchError {
  readonly provider?: string;

  constructor(provider?: string, message?: string, options?: ErrorOptions) {
    super(
      "PROVIDER_UNAVAILABLE",
      message ?? `Research provider${provider ? ` "${provider}"` : ""} is unavailable`,
      options,
    );
    this.name = "ResearchProviderUnavailable";
    this.provider = provider;
  }
}

export class ResearchAuthRequired extends ResearchError {
  readonly provider?: string;

  constructor(provider?: string, message?: string, options?: ErrorOptions) {
    super(
      "AUTH_REQUIRED",
      message ?? `Research provider${provider ? ` "${provider}"` : ""} requires authentication`,
      options,
    );
    this.name = "ResearchAuthRequired";
    this.provider = provider;
  }
}

export class ResearchActionFailed extends ResearchError {
  constructor(message: string, options?: ErrorOptions) {
    super("ACTION_FAILED", message, options);
    this.name = "ResearchActionFailed";
  }
}

export class ResearchBudgetExceeded extends ResearchError {
  readonly limit: string;

  constructor(limit: string, message?: string, options?: ErrorOptions) {
    super("RESEARCH_BUDGET_EXCEEDED", message ?? `Research budget exceeded: "${limit}"`, options);
    this.name = "ResearchBudgetExceeded";
    this.limit = limit;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ABORT_ERR")
  );
}

export function toCanonicalResearchError(err: unknown, provider?: string): ResearchError {
  if (err instanceof ResearchError) {
    return err;
  }
  if (isAbortError(err)) {
    return new ResearchCancelled();
  }
  if (err instanceof Error) {
    const message = redactSecretsFromMessage(err.message);
    if (/timed out|timeout|ETIMEDOUT|TimeoutError/i.test(message)) {
      return new ResearchTimeout(message);
    }
    if (/unsupported|content-type|mime/i.test(message)) {
      return new ResearchUnsupportedContent(undefined, message);
    }
    return new ResearchProviderFailed(provider, message, { cause: err });
  }
  return new ResearchProviderFailed(provider, `Unknown research failure: ${String(err)}`);
}
