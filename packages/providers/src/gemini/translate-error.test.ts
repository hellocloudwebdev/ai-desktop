import { describe, expect, it } from "vitest";
import { ApiError } from "@google/genai";
import {
  ModelNotFoundError,
  ProviderError,
  ProviderRequestError,
} from "../core/provider-errors.js";
import { translateGeminiError } from "./translate-error.js";

describe("packages/providers: Gemini Error Translation (PR21.5)", () => {
  it("translates ApiError 400 into ProviderRequestError with statusCode 400 (§Step 9)", () => {
    const error = new ApiError({
      message: "Invalid field in generateContent request",
      status: 400,
    });

    const canonical = translateGeminiError(error);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect(canonical.code).toBe("PROVIDER_REQUEST_ERROR");
    expect((canonical as ProviderRequestError).statusCode).toBe(400);
    expect(canonical.providerId).toBe("gemini");
    expect(canonical.message).toContain("Gemini bad request");
  });

  it("translates ApiError 401 into ProviderRequestError with statusCode 401 (§Step 4)", () => {
    const error = new ApiError({
      message: "API key not valid. Please pass a valid API key.",
      status: 401,
    });

    const canonical = translateGeminiError(error);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect((canonical as ProviderRequestError).statusCode).toBe(401);
    expect(canonical.providerId).toBe("gemini");
    expect(canonical.message).toContain("authentication failed");
  });

  it("translates ApiError 403 into ProviderRequestError with statusCode 403 (§Step 5)", () => {
    const error = new ApiError({
      message: "Permission denied for project",
      status: 403,
    });

    const canonical = translateGeminiError(error);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect((canonical as ProviderRequestError).statusCode).toBe(403);
    expect(canonical.providerId).toBe("gemini");
    expect(canonical.message).toContain("permission denied");
  });

  it("translates model-not-found / 404 into canonical ModelNotFoundError (§Step 6)", () => {
    const error = new ApiError({
      message: "models/gemini-nonexistent is not found",
      status: 404,
    });

    const canonical = translateGeminiError(error, { modelId: "gemini:gemini-nonexistent" });

    expect(canonical).toBeInstanceOf(ModelNotFoundError);
    expect(canonical.code).toBe("MODEL_NOT_FOUND");
    expect((canonical as ModelNotFoundError).modelId).toBe("gemini:gemini-nonexistent");
    expect(canonical.providerId).toBe("gemini");
  });

  it("translates generic 404 without model context into ProviderRequestError", () => {
    const error = new ApiError({
      message: "Endpoint not found",
      status: 404,
    });

    const canonical = translateGeminiError(error);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect((canonical as ProviderRequestError).statusCode).toBe(404);
  });

  it("translates 429 into ProviderRequestError with statusCode 429 (§Step 7)", () => {
    const error = new ApiError({
      message: "Resource has been exhausted (e.g. check quota)",
      status: 429,
    });

    const canonical = translateGeminiError(error);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect((canonical as ProviderRequestError).statusCode).toBe(429);
    expect(canonical.message).toContain("rate limit exceeded");
  });

  it("translates 5xx errors into ProviderRequestError with exact status code (§Step 8)", () => {
    for (const code of [500, 502, 503, 504]) {
      const error = new ApiError({
        message: `Internal server failure ${code}`,
        status: code,
      });

      const canonical = translateGeminiError(error);

      expect(canonical).toBeInstanceOf(ProviderRequestError);
      expect((canonical as ProviderRequestError).statusCode).toBe(code);
      expect(canonical.message).toContain(`(${code})`);
    }
  });

  it("translates connection and network failures into ProviderRequestError (§Step 10)", () => {
    const connectionError = new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
    connectionError.name = "ConnectionError";

    const canonical = translateGeminiError(connectionError);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect(canonical.message).toContain("connection error");
    expect(canonical.cause).toBe(connectionError);
  });

  it("translates timeout failures into ProviderRequestError (§Step 10)", () => {
    const timeoutError = new Error("Request timed out after 30000ms");
    timeoutError.name = "RequestTimeoutError";

    const canonical = translateGeminiError(timeoutError);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect(canonical.message).toContain("timeout");
  });

  it("distinguishes caller cancellation (AbortError) from ordinary provider errors (§Step 10)", () => {
    const abortError = new Error("The user aborted a request.");
    abortError.name = "AbortError";

    const canonical = translateGeminiError(abortError);

    expect(canonical).toBeInstanceOf(ProviderError);
    expect(canonical.code).toBe("CANCELLED");
    expect(canonical.message).toContain("cancelled by the client");
    expect(canonical).not.toBeInstanceOf(ProviderRequestError);
  });

  it("distinguishes RequestAbortedError as cancellation", () => {
    const customAbort = new Error("Request was cancelled");
    customAbort.name = "RequestAbortedError";

    const canonical = translateGeminiError(customAbort);

    expect(canonical.code).toBe("CANCELLED");
    expect(canonical.message).toContain("cancelled by the client");
  });

  it("translates unknown Error into ProviderRequestError (§Step 11)", () => {
    const error = new Error("Unexpected parser crash");

    const canonical = translateGeminiError(error);

    expect(canonical).toBeInstanceOf(ProviderRequestError);
    expect(canonical.message).toContain("Unexpected parser crash");
    expect(canonical.providerId).toBe("gemini");
  });

  it("translates non-Error throwables into ProviderRequestError (§Step 11)", () => {
    const canonicalStr = translateGeminiError("unexpected string throw");
    expect(canonicalStr).toBeInstanceOf(ProviderRequestError);
    expect(canonicalStr.message).toContain("unexpected string throw");

    const canonicalObj = translateGeminiError({ unexpected: "object" });
    expect(canonicalObj).toBeInstanceOf(ProviderRequestError);
  });

  it("returns already-canonical ProviderError instances untouched", () => {
    const existing = new ProviderRequestError("Existing canonical error", {
      providerId: "gemini",
      statusCode: 418,
    });

    const translated = translateGeminiError(existing);
    expect(translated).toBe(existing);
  });

  it("sanitizes raw credentials, tokens, and authorization headers from error messages (§Step 17)", () => {
    const sensitiveMessages = [
      "Failed with key sk-1234567890abcdef1234 while contacting host",
      "Request failed with token: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q",
      "Authorization error using Bearer secretToken123456789",
      "URL https://api.google.com?access_token=superSecretTokenValue123 failed",
      "Error: refresh_token=verySecretRefreshToken&other=1",
    ];

    for (const msg of sensitiveMessages) {
      const canonical = translateGeminiError(new Error(msg));

      // Credential material must be redacted (§Step 17)
      expect(canonical.message).not.toContain("sk-1234567890abcdef1234");
      expect(canonical.message).not.toContain("AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q");
      expect(canonical.message).not.toContain("secretToken123456789");
      expect(canonical.message).not.toContain("superSecretTokenValue123");
      expect(canonical.message).not.toContain("verySecretRefreshToken");
      expect(canonical.message).toContain("REDACTED");
    }
  });

  it("ensures SDK-specific error object is not exposed through public canonical fields (§Step 12)", () => {
    const apiError = new ApiError({
      message: "Resource exhausted",
      status: 429,
    });
    (apiError as unknown as Record<string, unknown>).rawResponse = {
      headers: { "x-secret-header": "confidential" },
    };

    const canonical = translateGeminiError(apiError);

    // Only canonical fields are present
    expect(canonical.name).toBe("ProviderRequestError");
    expect("rawResponse" in canonical).toBe(false);
    expect(canonical.cause).toBe(apiError);
  });
});
