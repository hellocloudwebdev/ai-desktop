// PR11: packages/providers — Concrete AnthropicAdapter
//
// Invariants (Step 34):
//   1. Implements generic ProviderAdapter contract.
//   2. Anthropic SDK is completely encapsulated within packages/providers.
//   3. Resolves credentials strictly through SecretStore or explicit config.
//   4. Canonical ChatRequest -> native MessageCreateParams -> streaming AIEvents.
//   5. Cancellation propagates standard AbortSignal to the underlying HTTP request.
//   6. Translates all SDK exceptions to canonical ProviderError classes.

import Anthropic from "@anthropic-ai/sdk";
import { err, ok, type Result, createMessageId } from "@ai-desktop/shared";
import {
  asModelId,
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
import { ANTHROPIC_MODELS, ANTHROPIC_PROVIDER_ID } from "./anthropic-models.js";
import { translateChatRequest } from "./translate-request.js";
import { translateAnthropicStream } from "./translate-stream.js";
import { translateAnthropicError } from "./translate-error.js";

export interface AnthropicAdapterOptions {
  /**
   * Optional pre-configured Anthropic client instance (useful for testing/mocking).
   */
  readonly client?: Anthropic;
  /**
   * Optional custom list of supported models overriding defaults.
   */
  readonly models?: readonly ModelDefinition[];
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = ANTHROPIC_PROVIDER_ID;
  private _client?: Anthropic;
  private _config?: ProviderConfig;
  private readonly _models: ReadonlyMap<string, ModelDefinition>;

  constructor(options?: AnthropicAdapterOptions) {
    if (options?.client) {
      this._client = options.client;
    }
    const modelList = options?.models ?? ANTHROPIC_MODELS;
    this._models = new Map(modelList.map((m) => [m.id, m]));
  }

  get client(): Anthropic | undefined {
    return this._client;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    const valid = this.validateConfig(config);
    if (!valid.ok) {
      throw valid.error;
    }

    this._config = config;

    // In local development or testing, apiKey can be passed via metadata if not using SecretStore yet
    const explicitApiKey = config.metadata?.apiKey as string | undefined;

    if (!this._client) {
      this._client = new Anthropic({
        apiKey: explicitApiKey ?? "dummy-key-for-initialization",
        baseURL: config.endpointUrl,
        timeout: config.timeoutMs,
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
      if (trimmed.startsWith("sk-ant") || trimmed.startsWith("sk-")) {
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
        "AnthropicAdapter has not been initialized with a valid client or configuration",
        {
          providerId: this.providerId,
        },
      );
    }

    // 1. Translate canonical ChatRequest to Anthropic MessageCreateParamsStreaming
    const nativeParams = translateChatRequest(request, model);

    // 2. Invoke Anthropic streaming API passing signal for cooperative cancellation
    let nativeStream: AsyncIterable<Anthropic.MessageStreamEvent>;
    try {
      nativeStream = (await this._client.messages.create(nativeParams, {
        signal,
      })) as AsyncIterable<Anthropic.MessageStreamEvent>;
    } catch (err: unknown) {
      throw translateAnthropicError(err, this.providerId);
    }

    // 3. Translate provider stream to canonical AIEvents
    const messageId = createMessageId();
    try {
      for await (const event of translateAnthropicStream(nativeStream, {
        conversationId: request.conversationId,
        messageId,
      })) {
        if (signal?.aborted) {
          // Emit message.cancelled on abort
          yield {
            eventId: event.eventId,
            conversationId: request.conversationId,
            sequence: event.sequence,
            schemaVersion: 1,
            timestamp: event.timestamp,
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
      throw translateAnthropicError(err, this.providerId);
    }
  }
}
