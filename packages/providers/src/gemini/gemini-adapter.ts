// PR21.6: packages/providers — Concrete GeminiAdapter
//
// Invariants (Step 41 / PR21.6):
//   1. Implements canonical ProviderAdapter interface for Google Gemini.
//   2. GoogleGenAI SDK is completely encapsulated within packages/providers.
//   3. Resolves credentials through SecretStore or explicit config.
//   4. Canonical ChatRequest -> native GenerateContentParameters -> streaming AIEvents.
//   5. Cancellation propagates standard AbortSignal to native Gemini request config.
//   6. Translates all SDK exceptions to canonical ProviderError classes via translateGeminiError.

import { GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { err, ok, createMessageId, now, type Result } from "@ai-desktop/shared";
import {
  asModelId,
  createEventId,
  type AIEvent,
  type ChatRequest,
  type ModelCapability,
  type ModelDefinition,
  type ModelId,
  type ProviderId,
} from "@ai-desktop/ai-core";
import type { ProviderAdapter } from "../core/provider-adapter.js";
import type { ProviderConfig } from "../core/provider-config.js";
import { ModelNotFoundError, ProviderConfigError } from "../core/provider-errors.js";
import { GEMINI_MODELS, GEMINI_PROVIDER_ID } from "./gemini-models.js";
import { translateGeminiRequest } from "./translate-request.js";
import { translateGeminiStream } from "./translate-stream.js";
import { translateGeminiError } from "./translate-error.js";

export interface GeminiAdapterOptions {
  /**
   * Optional pre-configured GoogleGenAI client instance (useful for testing/mocking).
   */
  readonly client?: GoogleGenAI;
  /**
   * Optional custom list of supported models overriding defaults.
   */
  readonly models?: readonly ModelDefinition[];
}

export class GeminiAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = GEMINI_PROVIDER_ID;
  private _client?: GoogleGenAI;
  private _config?: ProviderConfig;
  private readonly _models: ReadonlyMap<string, ModelDefinition>;

  constructor(options?: GeminiAdapterOptions) {
    if (options?.client) {
      this._client = options.client;
    }
    const modelList = options?.models ?? GEMINI_MODELS;
    this._models = new Map(modelList.map((m) => [m.id, m]));
  }

  get client(): GoogleGenAI | undefined {
    return this._client;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    const valid = this.validateConfig(config);
    if (!valid.ok) {
      throw valid.error;
    }

    this._config = config;

    const explicitApiKey = config.metadata?.apiKey as string | undefined;

    if (!this._client) {
      this._client = new GoogleGenAI({
        apiKey: explicitApiKey ?? "dummy-key-for-initialization",
        ...(config.endpointUrl
          ? {
              httpOptions: {
                baseUrl: config.endpointUrl,
                timeout: config.timeoutMs,
              },
            }
          : config.timeoutMs
            ? {
                httpOptions: {
                  timeout: config.timeoutMs,
                },
              }
            : {}),
      });
    }
  }

  async listModels(): Promise<readonly ModelDefinition[]> {
    return Array.from(this._models.values());
  }

  async getModel(modelId: ModelId): Promise<ModelDefinition | undefined> {
    return this._models.get(modelId);
  }

  validateConfig(config: ProviderConfig): Result<void, ProviderConfigError> {
    if (!config || typeof config !== "object") {
      return err(
        new ProviderConfigError("Configuration object is required", {
          providerId: this.providerId,
        }),
      );
    }

    if (config.providerId !== this.providerId) {
      return err(
        new ProviderConfigError(
          `Provider ID mismatch: configuration specifies "${config.providerId}" but adapter is for "${this.providerId}"`,
          { providerId: this.providerId },
        ),
      );
    }

    if (config.endpointUrl) {
      try {
        const url = new URL(config.endpointUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return err(
            new ProviderConfigError(
              `Invalid endpointUrl: "${config.endpointUrl}" must be an HTTP or HTTPS URL`,
              { providerId: this.providerId },
            ),
          );
        }
      } catch {
        return err(
          new ProviderConfigError(
            `Invalid endpointUrl: "${config.endpointUrl}" must be a valid URL`,
            { providerId: this.providerId },
          ),
        );
      }
    }

    if (config.credentialRef !== undefined) {
      const trimmed = config.credentialRef.trim();
      if (!trimmed) {
        return err(
          new ProviderConfigError("credentialRef cannot be empty", {
            providerId: this.providerId,
          }),
        );
      }
      if (
        trimmed.startsWith("AIzaSy") ||
        trimmed.startsWith("sk-") ||
        trimmed.startsWith("Bearer ")
      ) {
        return err(
          new ProviderConfigError(
            "credentialRef appears to contain a raw API key instead of a secret reference",
            { providerId: this.providerId },
          ),
        );
      }
    }

    if (config.defaultModelId !== undefined) {
      const model = this._models.get(asModelId(config.defaultModelId));
      if (!model) {
        return err(
          new ProviderConfigError(
            `Unsupported default model "${config.defaultModelId}" for provider "${this.providerId}"`,
            { providerId: this.providerId },
          ),
        );
      }
    }

    if (config.timeoutMs !== undefined) {
      if (
        typeof config.timeoutMs !== "number" ||
        !Number.isInteger(config.timeoutMs) ||
        config.timeoutMs <= 0 ||
        !Number.isFinite(config.timeoutMs)
      ) {
        return err(
          new ProviderConfigError("timeoutMs must be a positive integer", {
            providerId: this.providerId,
          }),
        );
      }
    }

    return ok(undefined);
  }

  supports(modelId: ModelId, capability: ModelCapability): boolean {
    const model = this._models.get(modelId);
    if (!model) {
      return false;
    }
    return model.capabilities.includes(capability);
  }

  async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<AIEvent> {
    const model = this._models.get(request.modelId);
    if (!model) {
      throw new ModelNotFoundError(request.modelId, { providerId: this.providerId });
    }

    if (signal?.aborted) {
      return;
    }

    if (!this._client) {
      throw new ProviderConfigError(
        "GeminiAdapter has not been initialized with a valid client or configuration",
        {
          providerId: this.providerId,
        },
      );
    }

    // 1. Translate canonical ChatRequest to Gemini GenerateContentParameters
    const nativeParams = translateGeminiRequest(request, model);

    // 2. Forward AbortSignal to native request configuration (§PR21.6.10)
    if (signal) {
      nativeParams.config = {
        ...nativeParams.config,
        abortSignal: signal,
      };
    }

    // 3. Invoke native Gemini streaming API
    let nativeStream: AsyncIterable<GenerateContentResponse>;
    try {
      nativeStream = await this._client.models.generateContentStream(nativeParams);
    } catch (err: unknown) {
      throw translateGeminiError(err, { modelId: request.modelId, providerId: this.providerId });
    }

    // 4. Translate stream chunks to canonical AIEvents with cancellation propagation
    const messageId = createMessageId();
    try {
      for await (const event of translateGeminiStream(nativeStream, {
        conversationId: request.conversationId,
        messageId,
        modelId: request.modelId,
      })) {
        if (signal?.aborted) {
          yield {
            eventId: createEventId(),
            conversationId: request.conversationId,
            sequence: event.sequence,
            schemaVersion: 1,
            timestamp: now(),
            type: "message.cancelled",
            category: "core",
            messageId,
            reason: "Client aborted request",
          } as AIEvent;
          return;
        }
        yield event;
      }
    } catch (err: unknown) {
      throw translateGeminiError(err, { modelId: request.modelId, providerId: this.providerId });
    }
  }
}
