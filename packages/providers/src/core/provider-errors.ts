// PR10: packages/providers — Provider Errors
//
// Canonical error classes representing provider failure modes without
// leaking third-party SDK types (Anthropic, OpenAI, etc.) into the domain.

import { BaseError, type ErrorOptions } from "@ai-desktop/shared";

export class ProviderError extends BaseError {
  readonly providerId?: string;

  constructor(code: string, message: string, options?: ErrorOptions & { providerId?: string }) {
    super(code, message, options);
    this.name = "ProviderError";
    this.providerId = options?.providerId;
  }
}

export class ProviderConfigError extends ProviderError {
  constructor(message: string, options?: ErrorOptions & { providerId?: string }) {
    super("PROVIDER_CONFIG_ERROR", message, options);
    this.name = "ProviderConfigError";
  }
}

export class UnsupportedCapabilityError extends ProviderError {
  readonly capability: string;
  readonly modelId?: string;

  constructor(
    capability: string,
    message?: string,
    options?: ErrorOptions & { providerId?: string; modelId?: string },
  ) {
    const msg =
      message ??
      `Model "${options?.modelId ?? "unknown"}" does not support requested capability: "${capability}"`;
    super("UNSUPPORTED_CAPABILITY_ERROR", msg, options);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.modelId = options?.modelId;
  }
}

export class ModelNotFoundError extends ProviderError {
  readonly modelId: string;

  constructor(modelId: string, options?: ErrorOptions & { providerId?: string }) {
    super(
      "MODEL_NOT_FOUND",
      `Model "${modelId}" not found in provider "${options?.providerId ?? "unknown"}"`,
      options,
    );
    this.name = "ModelNotFoundError";
    this.modelId = modelId;
  }
}

export class ProviderRequestError extends ProviderError {
  readonly statusCode?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { providerId?: string; statusCode?: number },
  ) {
    super("PROVIDER_REQUEST_ERROR", message, options);
    this.name = "ProviderRequestError";
    this.statusCode = options?.statusCode;
  }
}
