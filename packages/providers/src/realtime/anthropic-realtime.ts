// PR40: packages/providers — Anthropic realtime provider (unsupported).
//
// The installed Anthropic SDK (0.124.0) has NO realtime API: a grep over its
// published .d.ts files for "realtime|websocket" yields zero hits.
// Anthropic exposes realtime: unsupported, and this module does not fake it.
//
// Consequently supportsRealtime() returns false ALWAYS, getCapabilities()
// returns an empty record, and createSession() throws
// UnsupportedCapabilityError before any network or SDK use.
// No Anthropic SDK imports appear here (none exist for realtime).

import type { ModelDefinition } from "@ai-desktop/ai-core";
import { UnsupportedCapabilityError } from "../core/provider-errors.js";
import { ANTHROPIC_PROVIDER_ID } from "../anthropic/anthropic-models.js";
import {
  unsupportedRealtimeCapabilities,
  type ProviderRealtimeCapabilities,
  type RealtimeProvider,
  type RealtimeProviderSession,
  type RealtimeSessionRequest,
} from "./realtime-provider.js";

export class AnthropicRealtimeProvider implements RealtimeProvider {
  readonly providerId = ANTHROPIC_PROVIDER_ID;

  /**
   * Always false: @anthropic-ai/sdk 0.124.0 exposes no realtime API
   * (verified by grep — zero "realtime|websocket" hits in its .d.ts).
   */
  supportsRealtime(_model: ModelDefinition): boolean {
    return false;
  }

  getCapabilities(_model: ModelDefinition): ProviderRealtimeCapabilities {
    return unsupportedRealtimeCapabilities();
  }

  async createSession(request: RealtimeSessionRequest): Promise<RealtimeProviderSession> {
    throw new UnsupportedCapabilityError(
      "realtime",
      `Realtime sessions are not supported by provider "anthropic" for model "${request.model.id}": @anthropic-ai/sdk 0.124.0 exposes no realtime API`,
      {
        providerId: this.providerId,
        modelId: request.model.id,
      },
    );
  }
}
