// PR11: packages/providers — Anthropic Error Translation Boundary
//
// Invariants:
//   - Translates raw Anthropic SDK exceptions into canonical ProviderError classes.
//   - Distinguishes cancellation (AbortError) from failure.
//   - Raw secrets or authentication tokens are never exposed in error text.
//   - Provider SDK error types never escape this boundary.

import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderConfigError,
  ProviderError,
  ProviderRequestError,
} from "../core/provider-errors.js";

/**
 * Translates an unknown caught error from the Anthropic SDK or HTTP layer
 * into a canonical ProviderError.
 */
export function translateAnthropicError(err: unknown, providerId = "anthropic"): Error {
  if (err instanceof ProviderError) {
    return err;
  }

  // Cancellation handling (AbortError or APIUserAbortError)
  if (
    (err instanceof Error && err.name === "AbortError") ||
    err instanceof Anthropic.APIUserAbortError ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name: string }).name === "APIUserAbortError")
  ) {
    return new ProviderError("CANCELLED", "The Anthropic request was cancelled by the client", {
      cause: err,
      providerId,
    });
  }

  // Authentication failures (401 / AuthenticationError)
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderConfigError(
      "Anthropic authentication failed. Verify that the configured credential is valid.",
      { cause: err, providerId },
    );
  }

  // Rate limiting (429 / RateLimitError)
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderRequestError("Anthropic rate limit exceeded. Please retry later.", {
      cause: err,
      providerId,
      statusCode: 429,
    });
  }

  // Bad request / validation (400 / BadRequestError)
  if (err instanceof Anthropic.BadRequestError) {
    return new ProviderRequestError(`Anthropic bad request: ${err.message}`, {
      cause: err,
      providerId,
      statusCode: 400,
    });
  }

  // Permission denied (403 / PermissionDeniedError)
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderRequestError(`Anthropic permission denied: ${err.message}`, {
      cause: err,
      providerId,
      statusCode: 403,
    });
  }

  // Not found (404 / NotFoundError)
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderRequestError(`Anthropic resource not found: ${err.message}`, {
      cause: err,
      providerId,
      statusCode: 404,
    });
  }

  // Server error (500+ / InternalServerError)
  if (err instanceof Anthropic.InternalServerError) {
    return new ProviderRequestError("Anthropic internal server error. Please try again.", {
      cause: err,
      providerId,
      statusCode: 500,
    });
  }

  // Generic Anthropic APIError
  if (err instanceof Anthropic.APIError) {
    return new ProviderRequestError(`Anthropic API error: ${err.message}`, {
      cause: err,
      providerId,
      statusCode: err.status,
    });
  }

  if (err instanceof Error) {
    return new ProviderError("PROVIDER_REQUEST_FAILED", err.message, {
      cause: err,
      providerId,
    });
  }

  return new ProviderError("UNKNOWN_PROVIDER_ERROR", String(err), {
    providerId,
  });
}
