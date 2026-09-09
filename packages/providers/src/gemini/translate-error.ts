// PR21.5: packages/providers — Gemini Error Translation Boundary
//
// Invariants (Step 41 / PR21.5):
//   1. Translates raw Gemini / @google/genai exceptions into canonical ProviderError subclasses.
//   2. Provider SDK error types never escape packages/providers.
//   3. Distinguishes caller cancellation (AbortError, RequestAbortedError) from failure.
//   4. Error messages are sanitized: raw secrets, tokens, or auth headers are never exposed.
//   5. Maps HTTP status codes: 401 (auth), 403 (permission), 404 (model/resource not found),
//      429 (rate limit), 5xx (service failure), 400 (bad request).
//   6. All unknown or non-Error throwables become canonical ProviderRequestError.
//   7. Preserves canonical providerId ("gemini") and optional modelId context.

import {
  ModelNotFoundError,
  ProviderError,
  ProviderRequestError,
} from "../core/provider-errors.js";
import { GEMINI_PROVIDER_ID } from "./gemini-models.js";

export interface GeminiErrorContext {
  readonly modelId?: string;
  readonly providerId?: string;
}

/**
 * Sanitizes an error message string, removing raw API keys, bearer tokens, or secrets (§Step 12, §Step 17).
 */
function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/gi, "[REDACTED_KEY]")
    .replace(/(AIza[0-9A-Za-z-_]{35})/g, "[REDACTED_KEY]")
    .replace(/((?:access_token|refresh_token|api_key|password|secret)=)[^\s&]+/gi, "$1[REDACTED]");
}

/**
 * Extracts a safe, sanitized string message from an unknown error without serializing SDK metadata.
 */
function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return sanitizeErrorMessage(error.message);
  }
  if (typeof error === "string") {
    return sanitizeErrorMessage(error);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return sanitizeErrorMessage((error as { message: string }).message);
  }
  return "An unexpected error occurred during the Gemini provider operation";
}

/**
 * Extracts HTTP status code from SDK error shapes if available (§Step 13).
 */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    if ("status" in error && typeof (error as { status: unknown }).status === "number") {
      return (error as { status: number }).status;
    }
    if (
      "statusCode" in error &&
      typeof (error as { statusCode: unknown }).statusCode === "number"
    ) {
      return (error as { statusCode: number }).statusCode;
    }
    if ("status" in error && typeof (error as { status: unknown }).status === "string") {
      const parsed = parseInt((error as { status: string }).status, 10);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Translates an unknown caught error from @google/genai or the network layer
 * into a canonical ProviderError subclass (§Step 2).
 *
 * @param error Unknown error caught during Gemini API execution.
 * @param context Optional context containing modelId or providerId.
 * @returns Canonical ProviderError subclass.
 */
export function translateGeminiError(error: unknown, context?: GeminiErrorContext): ProviderError {
  const providerId = context?.providerId ?? GEMINI_PROVIDER_ID;

  // 1. Return already-canonical ProviderErrors untouched
  if (error instanceof ProviderError) {
    return error;
  }

  // 2. Caller abort / cancellation handling (§Step 10)
  if (
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "RequestAbortedError" ||
        error.name === "APIUserAbortError" ||
        error.message === "Request was cancelled")) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      ((error as { name: string }).name === "RequestAbortedError" ||
        (error as { name: string }).name === "APIUserAbortError"))
  ) {
    return new ProviderError("CANCELLED", "The Gemini request was cancelled by the client", {
      cause: error,
      providerId,
    });
  }

  const safeMessage = getSafeErrorMessage(error);
  const status = extractStatusCode(error);

  // 3. 401: Authentication failure (§Step 4)
  if (
    status === 401 ||
    (error instanceof Error &&
      (error.name === "AuthenticationError" ||
        /unauthenticated|invalid api key|api key not valid/i.test(safeMessage)))
  ) {
    return new ProviderRequestError(
      "Gemini authentication failed. Verify that the configured credential is valid.",
      {
        cause: error,
        providerId,
        statusCode: 401,
      },
    );
  }

  // 4. 403: Permission denied (§Step 5)
  if (
    status === 403 ||
    (error instanceof Error &&
      (error.name === "PermissionDeniedError" || /permission denied/i.test(safeMessage)))
  ) {
    return new ProviderRequestError(
      "Gemini permission denied. Verify that the configured credential has access to this resource.",
      {
        cause: error,
        providerId,
        statusCode: 403,
      },
    );
  }

  // 5. 404: Not Found / Model Not Found (§Step 6)
  if (
    status === 404 ||
    (error instanceof Error &&
      (error.name === "NotFoundError" || /model.*not found|not found.*model/i.test(safeMessage)))
  ) {
    const isModelNotFound =
      Boolean(context?.modelId) ||
      /models\//i.test(safeMessage) ||
      /model.*not found|not found.*model/i.test(safeMessage);

    if (isModelNotFound) {
      return new ModelNotFoundError(context?.modelId ?? "unknown", {
        cause: error,
        providerId,
      });
    }

    return new ProviderRequestError(`Gemini resource not found: ${safeMessage}`, {
      cause: error,
      providerId,
      statusCode: 404,
    });
  }

  // 6. 429: Rate limit / Quota exceeded (§Step 7)
  if (
    status === 429 ||
    (error instanceof Error &&
      (error.name === "RateLimitError" ||
        /rate limit|quota exceeded|too many requests/i.test(safeMessage)))
  ) {
    return new ProviderRequestError("Gemini rate limit exceeded. Please retry later.", {
      cause: error,
      providerId,
      statusCode: 429,
    });
  }

  // 7. 5xx: Server and service failures (§Step 8)
  if (
    (status !== undefined && status >= 500 && status < 600) ||
    (error instanceof Error &&
      (error.name === "InternalServerError" ||
        /internal server error|service unavailable/i.test(safeMessage)))
  ) {
    return new ProviderRequestError(
      `Gemini service error${status ? ` (${status})` : ""}: ${safeMessage}`,
      {
        cause: error,
        providerId,
        statusCode: status ?? 500,
      },
    );
  }

  // 8. 400: Bad Request / Invalid parameters (§Step 9)
  if (
    status === 400 ||
    (error instanceof Error &&
      (error.name === "BadRequestError" || error.name === "InvalidRequestError"))
  ) {
    return new ProviderRequestError(`Gemini bad request: ${safeMessage}`, {
      cause: error,
      providerId,
      statusCode: 400,
    });
  }

  // 9. Client-side network / connection errors (§Step 10)
  if (
    error instanceof Error &&
    (error.name === "ConnectionError" ||
      error.name === "APIConnectionError" ||
      /ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(error.message))
  ) {
    return new ProviderRequestError(`Gemini connection error: ${safeMessage}`, {
      cause: error,
      providerId,
    });
  }

  // 10. Client-side timeout errors (§Step 10)
  if (
    error instanceof Error &&
    (error.name === "RequestTimeoutError" ||
      error.name === "APIConnectionTimeoutError" ||
      /timeout|ETIMEDOUT/i.test(error.message))
  ) {
    return new ProviderRequestError(`Gemini request timeout: ${safeMessage}`, {
      cause: error,
      providerId,
    });
  }

  // 11. Generic Error instance (§Step 11)
  if (error instanceof Error) {
    return new ProviderRequestError(`Gemini request failed: ${safeMessage}`, {
      cause: error,
      providerId,
      statusCode: status,
    });
  }

  // 12. Non-Error throwables (e.g. throw "boom", throw { ... }) (§Step 11)
  return new ProviderRequestError(`Gemini request failed: ${safeMessage}`, {
    providerId,
  });
}
