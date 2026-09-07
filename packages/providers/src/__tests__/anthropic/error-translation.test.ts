import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { translateAnthropicError } from "../../anthropic/translate-error.js";
import {
  ProviderConfigError,
  ProviderError,
  ProviderRequestError,
} from "../../core/provider-errors.js";

describe("Anthropic: Error Translation Boundary", () => {
  it("translates abort exceptions into canonical CANCELLED ProviderError", () => {
    const abortErr = new Error("Request was aborted");
    abortErr.name = "AbortError";

    const translated = translateAnthropicError(abortErr);
    expect(translated).toBeInstanceOf(ProviderError);
    expect((translated as ProviderError).code).toBe("CANCELLED");
    expect(translated.message).toContain("cancelled");
  });

  it("translates 401 AuthenticationError into canonical ProviderConfigError", () => {
    const authErr = new Anthropic.AuthenticationError(
      401,
      { type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
      "Invalid API key",
      new Headers(),
    );

    const translated = translateAnthropicError(authErr);
    expect(translated).toBeInstanceOf(ProviderConfigError);
    expect((translated as ProviderConfigError).code).toBe("PROVIDER_CONFIG_ERROR");
  });

  it("translates 429 RateLimitError into ProviderRequestError with statusCode 429", () => {
    const rateErr = new Anthropic.RateLimitError(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } },
      "Rate limit exceeded",
      new Headers(),
    );

    const translated = translateAnthropicError(rateErr);
    expect(translated).toBeInstanceOf(ProviderRequestError);
    expect((translated as ProviderRequestError).statusCode).toBe(429);
  });

  it("translates generic APIError cleanly into ProviderRequestError", () => {
    const genericErr = new Anthropic.APIError(
      502,
      { type: "error", error: { type: "api_error", message: "Bad Gateway" } },
      "Bad Gateway",
      new Headers(),
    );

    const translated = translateAnthropicError(genericErr);
    expect(translated).toBeInstanceOf(ProviderRequestError);
    expect((translated as ProviderRequestError).statusCode).toBe(502);
  });
});
